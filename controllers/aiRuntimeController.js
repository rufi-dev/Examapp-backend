const asyncHandler = require("express-async-handler");
const { getAiExecution, setAiExecution, MODES, CLI_PROVIDERS } = require("../config/aiExecution");

const get = asyncHandler(async (req, res) => {
  res.json({ settings: await getAiExecution(), modes: MODES, cliProviders: CLI_PROVIDERS });
});

const update = asyncHandler(async (req, res) => {
  const value = await setAiExecution(req.body || {});
  res.json({ settings: value, modes: MODES, cliProviders: CLI_PROVIDERS });
});

module.exports = { get, update };
