import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BackupsView,
  Board,
  BoardView,
  Card,
  CardDetail,
  Comment,
  CreateCardInput,
  Me,
  MoveCardInput,
  NotificationsView,
  SessionSummary,
  SessionTranscript,
  Settings,
  UpdateCardInput,
  User,
} from "@kardboard/shared";
import { useRef } from "react";
import { ApiError, errorCode, NO_RESPONSE, shouldRetry } from "./errors";
import { postComment, UploadFailed, type CommentRequests, type PostProgress } from "./commentPost";

let tokenProvider: () => Promise<string | null> = async () => null;
export function setTokenProvider(fn: () => Promise<string | null>) {
  tokenProvider = fn;
}

export { ApiError };

// Every call to the API goes through here, files included: the server authenticates the bearer
// token and nothing else, so a plain <img src> or <a href> to /api is refused in production.
async function send(path: string, init: RequestInit): Promise<Response> {
  const token = await tokenProvider();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  try {
    return await fetch(`/api${path}`, { ...init, headers });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(NO_RESPONSE, "network", null);
  }
}

async function failure(res: Response): Promise<ApiError> {
  const data: unknown = await res.json().catch(() => ({}));
  return new ApiError(res.status, errorCode(data, res.status), data);
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await failure(res);
  return (await res.json().catch(() => ({}))) as T;
}

export async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const res = await send(path, init);
  if (!res.ok) throw await failure(res);
  return res.blob();
}

export const keys = {
  me: ["me"] as const,
  boards: ["boards"] as const,
  board: (slug: string) => ["board", slug] as const,
  card: (id: string) => ["card", id] as const,
  notifications: ["notifications"] as const,
  adminUsers: ["admin", "users"] as const,
  adminBoards: ["admin", "boards"] as const,
  adminSettings: ["admin", "settings"] as const,
  adminSessions: ["admin", "sessions"] as const,
  adminBackups: ["admin", "backups"] as const,
};

export function useMe() {
  // A 401 or 403 is an answer; a dropped connection or a restarting server is worth another try.
  return useQuery({ queryKey: keys.me, queryFn: () => request<Me>("/me"), staleTime: 60_000, retry: (count, err) => shouldRetry(count, err) });
}
export function useBoards() {
  return useQuery({ queryKey: keys.boards, queryFn: () => request<Board[]>("/boards") });
}
export function useBoard(slug: string) {
  return useQuery({ queryKey: keys.board(slug), queryFn: () => request<BoardView>(`/boards/${slug}`) });
}
export function useCard(id: string | null) {
  return useQuery({ queryKey: keys.card(id ?? ""), queryFn: () => request<CardDetail>(`/cards/${id}`), enabled: Boolean(id) });
}

// The bell lives outside any board, so it polls rather than riding a board's event stream.
export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => request<NotificationsView>("/notifications"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => request<NotificationsView>("/notifications/read", { method: "POST", body: JSON.stringify(ids ? { ids } : {}) }),
    onSuccess: (view) => qc.setQueryData(keys.notifications, view),
  });
}

export function useCreateCard(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCardInput) => request<Card>(`/boards/${slug}/cards`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (card) => upsertCardInBoard(qc, slug, card),
  });
}

export function useUpdateCard(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCardInput & { id: string }) => request<Card>(`/cards/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: (card) => {
      upsertCardInBoard(qc, slug, card);
      qc.setQueryData<CardDetail>(keys.card(card.id), (d) => (d ? { ...d, card } : d));
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && err.status === 409) void qc.invalidateQueries({ queryKey: keys.card(vars.id) });
    },
  });
}

export function useMoveCard(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: MoveCardInput & { id: string }) => request<Card>(`/cards/${id}/move`, { method: "POST", body: JSON.stringify(input) }),
    onMutate: async ({ id, column, position }) => {
      await qc.cancelQueries({ queryKey: keys.board(slug) });
      const prev = qc.getQueryData<BoardView>(keys.board(slug));
      qc.setQueryData<BoardView>(keys.board(slug), (v) => (v ? { ...v, cards: v.cards.map((c) => (c.id === id ? { ...c, column, position } : c)) } : v));
      return { prev };
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.board(slug), ctx.prev);
      void qc.invalidateQueries({ queryKey: keys.board(slug) });
      void qc.invalidateQueries({ queryKey: keys.card(vars.id) });
    },
    // The open sheet reads the card-detail cache, so a move made from it must land there too.
    onSuccess: (card) => {
      upsertCardInBoard(qc, slug, card);
      qc.setQueryData<CardDetail>(keys.card(card.id), (d) => (d ? { ...d, card } : d));
    },
  });
}

// Approval names the pull request head the card showed; the server refuses it if that has moved on,
// and may record the newer head, so the card is re-read either way.
export function useApproveCard(slug: string) {
  const qc = useQueryClient();
  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: keys.card(id) });
    void qc.invalidateQueries({ queryKey: keys.board(slug) });
  };
  return useMutation({
    mutationFn: ({ id, headSha, overrideChecks }: { id: string; headSha: string | null; overrideChecks?: boolean }) =>
      request(`/cards/${id}/approve`, { method: "POST", body: JSON.stringify({ headSha, ...(overrideChecks ? { overrideChecks } : {}) }) }),
    onSuccess: (_r, { id }) => refresh(id),
    onError: (_e, { id }) => refresh(id),
  });
}

// A refused retry can still have changed the Card: a moved pull request voids the Approval.
export function useRetryMerge(slug: string) {
  const qc = useQueryClient();
  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: keys.card(id) });
    void qc.invalidateQueries({ queryKey: keys.board(slug) });
  };
  return useMutation({
    mutationFn: ({ id, overrideChecks }: { id: string; overrideChecks?: boolean }) => request(`/cards/${id}/retry-merge`, { method: "POST", body: JSON.stringify(overrideChecks ? { overrideChecks } : {}) }),
    onSuccess: (_r, { id }) => refresh(id),
    onError: (_e, { id }) => refresh(id),
  });
}

// Opening a Card in Review asks the server to read its pull request and checks from GitHub again.
// Anything that changed also arrives over the event stream; the answer just lands it sooner here.
export function useSyncCard(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<Card>(`/cards/${id}/sync`, { method: "POST" }),
    onSuccess: (card) => {
      upsertCardInBoard(qc, slug, card);
      qc.setQueryData<CardDetail>(keys.card(card.id), (d) => (d ? { ...d, card } : d));
    },
  });
}

// Try again after a Session failed or ran out of time. The Session starts at once, so the board's
// event stream usually reports it before this answer arrives; the answer is re-read rather than
// written into the cache, where it would put back the wait the Session already ended.
export function useRetryCard(slug: string) {
  const qc = useQueryClient();
  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: keys.card(id) });
    void qc.invalidateQueries({ queryKey: keys.board(slug) });
  };
  return useMutation({
    mutationFn: (id: string) => request<Card>(`/cards/${id}/retry`, { method: "POST" }),
    onSuccess: (_card, id) => refresh(id),
    onError: (_e, id) => refresh(id),
  });
}

// The Admin's pause switch for one Board. The Board's event stream carries the change to everyone
// else; this writes it into the caller's own view at once.
export function useSetBoardPaused(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ boardId, paused }: { boardId: string; paused: boolean }) => request<Board>(`/admin/boards/${boardId}/pause`, { method: "POST", body: JSON.stringify({ paused }) }),
    onSuccess: (board) => {
      qc.setQueryData<BoardView>(keys.board(slug), (v) => (v ? { ...v, board } : v));
      void qc.invalidateQueries({ queryKey: keys.adminBoards });
    },
  });
}

export function useCreateComment(cardId: string) {
  const qc = useQueryClient();
  // What a failed attempt already posted, so pressing Post again finishes it instead of duplicating it.
  const progress = useRef<PostProgress<File> | null>(null);
  return useMutation({
    mutationFn: async ({ body, files }: { body: string; files: File[] }) => {
      const requests: CommentRequests<File> = {
        create: (text) => request<Comment>(`/cards/${cardId}/comments`, { method: "POST", body: JSON.stringify({ body: text }) }),
        edit: (id, text) => request<Comment>(`/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body: text }) }),
        upload: (id, file) => {
          const fd = new FormData();
          fd.append("file", file);
          return request(`/comments/${id}/attachments`, { method: "POST", body: fd });
        },
      };
      try {
        await postComment(requests, body, files, progress.current, (p) => (progress.current = p));
      } catch (err) {
        if (err instanceof UploadFailed) throw new Error(`Your comment is posted, but ${(err.file as File).name} did not upload. ${err.message} Post again to send the files that are left.`);
        throw err;
      }
      progress.current = null;
    },
    // Settled, not succeeded: after a failed upload the comment itself is already there to show.
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.card(cardId) }),
  });
}

export function useUpdateComment(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => request<Comment>(`/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.card(cardId) }),
  });
}

export function upsertCardInBoard(qc: ReturnType<typeof useQueryClient>, slug: string, card: Card) {
  qc.setQueryData<BoardView>(keys.board(slug), (v) => {
    if (!v) return v;
    const exists = v.cards.some((c) => c.id === card.id);
    return { ...v, cards: exists ? v.cards.map((c) => (c.id === card.id ? card : c)) : [...v.cards, card] };
  });
}

export function upsertSessionInBoard(qc: ReturnType<typeof useQueryClient>, slug: string, session: SessionSummary) {
  qc.setQueryData<BoardView>(keys.board(slug), (v) => {
    if (!v) return v;
    const exists = v.sessions.some((s) => s.id === session.id);
    return { ...v, sessions: exists ? v.sessions.map((s) => (s.id === session.id ? session : s)) : [session, ...v.sessions] };
  });
}

// ---- admin ----
export type AdminBoard = Board & { memberIds: string[] };
export function useAdminUsers() {
  return useQuery({ queryKey: keys.adminUsers, queryFn: () => request<User[]>("/admin/users") });
}
export function useAdminBoards() {
  return useQuery({ queryKey: keys.adminBoards, queryFn: () => request<AdminBoard[]>("/admin/boards") });
}
export function useAdminSettings() {
  return useQuery({ queryKey: keys.adminSettings, queryFn: () => request<Settings>("/admin/settings") });
}
export function useAdminSessions() {
  return useQuery({ queryKey: keys.adminSessions, queryFn: () => request<(SessionSummary & { boardId: string })[]>("/admin/sessions"), refetchInterval: 10_000 });
}
// Transcripts are tailed by byte offset rather than cached by react-query: each call returns only
// what the session has written since `offset`, and the caller keeps the running list.
export function fetchSessionTranscript(sessionId: string, offset: number) {
  return request<SessionTranscript>(`/admin/sessions/${sessionId}/transcript?offset=${offset}`);
}

export function useAdminBackups() {
  return useQuery({ queryKey: keys.adminBackups, queryFn: () => request<BackupsView>("/admin/backups") });
}
export function useTakeBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<BackupsView>("/admin/backups", { method: "POST" }),
    onSuccess: (view) => qc.setQueryData(keys.adminBackups, view),
  });
}
