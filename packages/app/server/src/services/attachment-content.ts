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

type VisionType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Which vision format the bytes are, by their signature. The declared type is whatever the
 * uploader's browser said, and an image sent under the wrong type is refused by the provider.
 */
export function sniffImage(bytes: Uint8Array): VisionType | null {
  const has = (signature: number[], at = 0) => bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (has([0x47, 0x49, 0x46, 0x38]) && (has([0x37, 0x61], 4) || has([0x39, 0x61], 4))) return "image/gif";
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

// Claude refuses an image whose base64 is over 5 MB, and the refused image stays in the conversation,
// so every later turn of the Session fails the same way. The limit is on the encoded size, which is
// four thirds of the file's: 3.75 MB of image.
export const INLINE_IMAGE_LIMIT = 5 * 1024 * 1024;
const encodedSize = (bytes: number) => Math.ceil(bytes / 3) * 4;

export function attachmentContent(att: { filename: string; mime: string }, bytes: Buffer): AttachmentContent {
  const image = sniffImage(bytes);
  if (image) {
    if (encodedSize(bytes.length) <= INLINE_IMAGE_LIMIT) return { type: "image", data: bytes.toString("base64"), mimeType: image };
    return { type: "text", text: `${att.filename}: ${image}, ${size(bytes.length)}. Too large to show: the model takes images up to 3.75 MB. Ask for a smaller one if you need to see it.` };
  }
  if (VISION_TYPES.has(att.mime) && !looksLikeText(bytes)) {
    return { type: "text", text: `${att.filename}: uploaded as ${att.mime}, ${size(bytes.length)}, but its contents are not a PNG, JPEG, GIF, or WebP image. Not shown.` };
  }
  if (!isTextAttachment(att.mime, bytes)) {
    const hint = att.mime.startsWith("image/") ? " The model cannot view this image format; ask for a PNG or JPEG if you need to see it." : "";
    return { type: "text", text: `${att.filename}: ${att.mime || "unknown type"}, ${size(bytes.length)}. Binary; not shown.${hint}` };
  }
  if (bytes.length > INLINE_TEXT_LIMIT) return { type: "text", text: `${att.filename}: ${att.mime || "text"}, ${size(bytes.length)}. Too large to inline.` };
  return { type: "text", text: bytes.toString("utf8") };
}
