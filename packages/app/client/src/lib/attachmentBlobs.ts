import { isDisplayableImage, mimeEssence } from "@kardboard/shared";

// An object URL belongs to the app's own origin and carries only its Blob's type: none of the
// headers the server sent with the file, its sandbox policy included, come with it. Opened in a tab,
// through "Open image in new tab" or a download the browser chooses to show, a Blob typed as an SVG
// or an HTML page is a document whose script runs with the signed-in person's session. So every
// fetched Attachment is typed again before it gets a URL, from a list rather than from the response.

/** A picture as the raster type it was allowed as; anything else as bytes no browser renders. */
export function imageBlob(blob: Blob, mime: string): Blob {
  const type = mimeEssence(mime);
  return new Blob([blob], { type: isDisplayableImage(type) ? type : "application/octet-stream" });
}

/** A file to save, never to show, whatever it holds. */
export function downloadBlob(blob: Blob): Blob {
  return new Blob([blob], { type: "application/octet-stream" });
}
