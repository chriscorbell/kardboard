import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AccessToken,
  BackupsView,
  Board,
  BoardView,
  Card,
  CardDetail,
  Comment,
  CreateCardInput,
  CreatedAccessToken,
  Me,
  MoveCardInput,
  OverviewView,
  Settings,
  UpdateCardInput,
  UpdateMeInput,
} from "@kardboard/shared";
import { useRef } from "react";
import { ApiError, errorCode, NO_RESPONSE, shouldRetry } from "./errors";
import { postComment, UploadFailed, type CommentRequests, type PostProgress } from "./commentPost";

export { ApiError };

// Every call to the API goes through here, or through uploadFile below. They carry no credential:
// Tailscale Serve signs each request in on its way to the app.
async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
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

// An upload that reports how far it has got. fetch cannot say how much of a body it has sent, and a
// 25 MB video over a phone connection is long enough that someone should see it moving.
export async function uploadFile<T>(path: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        // A proxy's HTML error page: the status still says what happened.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(data as T);
      } else {
        reject(new ApiError(xhr.status, errorCode(data, xhr.status), data));
      }
    };
    xhr.onerror = () => reject(new ApiError(NO_RESPONSE, "network", null));
    xhr.send(form);
  });
}

export async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const res = await send(path, init);
  if (!res.ok) throw await failure(res);
  return res.blob();
}

export const keys = {
  me: ["me"] as const,
  boards: ["boards"] as const,
  overview: ["overview"] as const,
  board: (slug: string) => ["board", slug] as const,
  card: (id: string) => ["card", id] as const,
  adminBoards: ["admin", "boards"] as const,
  adminSettings: ["admin", "settings"] as const,
  adminBackups: ["admin", "backups"] as const,
  accessTokens: ["admin", "access-tokens"] as const,
};

export function useMe() {
  // A 401 or 403 is an answer; a dropped connection or a restarting server is worth another try.
  return useQuery({ queryKey: keys.me, queryFn: () => request<Me>("/me"), staleTime: 60_000, retry: (count, err) => shouldRetry(count, err) });
}
export function useBoards() {
  return useQuery({ queryKey: keys.boards, queryFn: () => request<Board[]>("/boards") });
}
// Every Board at once. Read again every twenty seconds and whenever the tab comes back, since it
// follows no single Board's event stream.
export function useOverview() {
  return useQuery({ queryKey: keys.overview, queryFn: () => request<OverviewView>("/overview"), refetchInterval: 20_000 });
}
export function useBoard(slug: string) {
  return useQuery({ queryKey: keys.board(slug), queryFn: () => request<BoardView>(`/boards/${slug}`) });
}
export function useCard(id: string | null) {
  return useQuery({ queryKey: keys.card(id ?? ""), queryFn: () => request<CardDetail>(`/cards/${id}`), enabled: Boolean(id) });
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

export type UploadProgress = (file: File, fraction: number) => void;

// The requests that post a Comment on a Card and upload its files, reporting each file's progress.
export function commentRequests(cardId: string, opts: { onProgress?: UploadProgress } = {}): CommentRequests<File> {
  return {
    create: (text) => request<Comment>(`/cards/${cardId}/comments`, { method: "POST", body: JSON.stringify({ body: text }) }),
    edit: (id, text) => request<Comment>(`/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body: text }) }),
    upload: (id, file) => uploadFile(`/comments/${id}/attachments`, file, (fraction) => opts.onProgress?.(file, fraction)),
  };
}

export function useCreateComment(cardId: string) {
  const qc = useQueryClient();
  // What a failed attempt already posted, so pressing Post again finishes it instead of duplicating it.
  const progress = useRef<PostProgress<File> | null>(null);
  return useMutation({
    mutationFn: async ({ body, files, onProgress }: { body: string; files: File[]; onProgress?: UploadProgress }) => {
      const requests = commentRequests(cardId, { onProgress });
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

// The User removes a Comment for good, theirs or the Agent's. The sheet drops it at once; the event stream
// tells everyone else.
export function useDeleteComment(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/comments/${id}`, { method: "DELETE" }),
    onSuccess: (_r, id) => qc.setQueryData<CardDetail>(keys.card(cardId), (d) => (d ? { ...d, comments: d.comments.filter((c) => c.id !== id) } : d)),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.card(cardId) }),
  });
}

// For good, with its Comments and Attachments. The Board drops it at once; the event stream tells
// everyone else, and closes it for anyone who has it open.
export function useDeleteCard(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/cards/${id}`, { method: "DELETE" }),
    onSuccess: (_r, id) => {
      qc.setQueryData<BoardView>(keys.board(slug), (v) => (v ? { ...v, cards: v.cards.filter((c) => c.id !== id) } : v));
      qc.removeQueries({ queryKey: keys.card(id) });
    },
  });
}

// The caller's own settings: whether the board explainer has been dismissed.
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMeInput) => request<Me>("/me", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: (me) => qc.setQueryData(keys.me, me),
  });
}

export function upsertCardInBoard(qc: ReturnType<typeof useQueryClient>, slug: string, card: Card) {
  qc.setQueryData<BoardView>(keys.board(slug), (v) => {
    if (!v) return v;
    const exists = v.cards.some((c) => c.id === card.id);
    return { ...v, cards: exists ? v.cards.map((c) => (c.id === card.id ? card : c)) : [...v.cards, card] };
  });
}

// ---- settings ----
export function useAdminBoards() {
  return useQuery({ queryKey: keys.adminBoards, queryFn: () => request<Board[]>("/admin/boards") });
}
export function useAccessTokens() {
  return useQuery({ queryKey: keys.accessTokens, queryFn: () => request<AccessToken[]>("/admin/tokens") });
}
export function useCreateAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => request<CreatedAccessToken>("/admin/tokens", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.accessTokens }),
  });
}
export function useRevokeAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => request(`/admin/tokens/${tokenId}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.accessTokens }),
  });
}
export function useAdminSettings() {
  return useQuery({ queryKey: keys.adminSettings, queryFn: () => request<Settings>("/admin/settings") });
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
