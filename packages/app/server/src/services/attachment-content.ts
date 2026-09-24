// What `read_attachment` hands a Session. Images go to the model as vision input and text as
// text. Anything else used to be decoded as UTF-8 too, so a client's PDF brief arrived as a page of
// replacement characters that cost tokens and said nothing; now it is named and left alone.

export const INLINE_TEXT_LIMIT = 200_000;

// Types that are text whatever their prefix says. Everything else is judged by its bytes, since
// uploads often arrive as application/octet-stream whatever they hold.
const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|x-ndjson|xml|javascript|ecmascript|x-yaml|yaml|toml|x-toml|x-sh|x-shellscript|sql|graphql|csv|x-httpd-php|x-python)$|application\/[\w.+-]+\+(json|xml)$|image\/svg\+xml$)/i;

const SNIFF_BYTES = 8_192;

/** Text is valid UTF-8 with no NUL byte. A multibyte character cut off by the sample is not held against it. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, SNIFF_BYTES);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: sample.length < bytes.length });
    return true;
  } catch {
    return false;
  }
}

export function isTextAttachment(mime: string, bytes: Uint8Array): boolean {
  if (TEXT_TYPES.test(mime)) return !bytes.subarray(0, SNIFF_BYTES).includes(0);
  return looksLikeText(bytes);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type AttachmentContent = { type: "image"; data: string; mimeType: string } | { type: "text"; text: string };

// The image formats both Providers accept as vision input. Another image type, such as a phone's
// HEIC photo, would fail the model request it rode in on, and SVG reads better as the text it is.
const VISION_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function attachmentContent(att: { filename: string; mime: string }, bytes: Buffer): AttachmentContent {
  if (VISION_TYPES.has(att.mime)) return { type: "image", data: bytes.toString("base64"), mimeType: att.mime };
  if (!isTextAttachment(att.mime, bytes)) {
    const hint = att.mime.startsWith("image/") ? " The model cannot view this image format; ask for a PNG or JPEG if you need to see it." : "";
    return { type: "text", text: `${att.filename}: ${att.mime || "unknown type"}, ${size(bytes.length)}. Binary; not shown.${hint}` };
  }
  if (bytes.length > INLINE_TEXT_LIMIT) return { type: "text", text: `${att.filename}: ${att.mime || "text"}, ${size(bytes.length)}. Too large to inline.` };
  return { type: "text", text: bytes.toString("utf8") };
}
