// Worker thread for sheetOmr: OpenCV.js analysis off the API event loop.
const { parentPort } = require("worker_threads");
const { analyzeJpeg } = require("./sheetOmr");

parentPort.on("message", async ({ id, buffer, opts }) => {
  try {
    const result = await analyzeJpeg(Buffer.from(buffer), opts);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e?.message || String(e) });
  }
});
