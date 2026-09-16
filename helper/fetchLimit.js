/*
 * Body bytes, but never more than `limit`.
 *
 * Checking the size only after `arrayBuffer()` means a hostile or broken response
 * is fully buffered in memory before it is rejected. This refuses on
 * Content-Length when it is declared, and otherwise stops mid-stream.
 *
 * Lives in its own module because BOTH helper/paperReader and controllers/
 * aiController need it, and importing one from the other would close a require
 * cycle (they already depend on each other for the sheet-reading helpers).
 *
 * → Buffer, or null when the response is over the limit.
 */
async function readCapped(res, limit) {
  const declared = Number(res?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    res.body?.cancel?.()?.catch?.(() => {});
    return null;
  }
  if (!res?.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > limit ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

module.exports = { readCapped };
