// Posting a Comment with files is several requests: the Comment, then one upload per file. When an
// upload fails the Comment already exists, so a retry must carry on with it rather than post again.
export type PostProgress<F> = { commentId: string; body: string; uploaded: F[] };

export type CommentRequests<F> = {
  create: (body: string) => Promise<{ id: string }>;
  edit: (commentId: string, body: string) => Promise<unknown>;
  upload: (commentId: string, file: F) => Promise<unknown>;
};

export class UploadFailed<F> extends Error {
  constructor(
    public file: F,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Upload failed.", { cause });
    this.name = "UploadFailed";
  }
}

// `progress` is what an earlier, interrupted attempt got done; `save` records each step as it lands.
// A body changed between attempts is saved as an edit of the Comment already posted.
export async function postComment<F>(requests: CommentRequests<F>, body: string, files: F[], progress: PostProgress<F> | null, save: (p: PostProgress<F>) => void): Promise<string> {
  let p = progress;
  if (!p) {
    const comment = await requests.create(body);
    p = { commentId: comment.id, body, uploaded: [] };
    save(p);
  } else if (p.body !== body) {
    await requests.edit(p.commentId, body);
    p = { ...p, body };
    save(p);
  }
  for (const file of files) {
    if (p.uploaded.includes(file)) continue;
    try {
      await requests.upload(p.commentId, file);
    } catch (err) {
      throw new UploadFailed(file, err);
    }
    p = { ...p, uploaded: [...p.uploaded, file] };
    save(p);
  }
  return p.commentId;
}
