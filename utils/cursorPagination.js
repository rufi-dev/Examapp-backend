const mongoose = require("mongoose");
const { httpError } = require("./appError");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function pageLimit(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    at: new Date(row.createdAt).toISOString(),
    id: String(row._id),
  })).toString("base64url");
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    const at = new Date(value.at);
    if (Number.isNaN(at.getTime()) || !mongoose.isValidObjectId(value.id)) return null;
    return { at, id: new mongoose.Types.ObjectId(value.id) };
  } catch {
    return null;
  }
}

function withCursor(filter, rawCursor, direction = -1) {
  const cursor = decodeCursor(rawCursor);
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== "" && !cursor) {
    throw httpError(400, "invalid_cursor", "Invalid pagination cursor");
  }
  if (!cursor) return filter;
  const op = direction === 1 ? "$gt" : "$lt";
  return {
    $and: [
      filter,
      {
        $or: [
          { createdAt: { [op]: cursor.at } },
          { createdAt: cursor.at, _id: { [op]: cursor.id } },
        ],
      },
    ],
  };
}

function pageResult(rows, limit) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    hasMore,
    nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]) : null,
  };
}

function wantsEnvelope(req) {
  return req.query?.pageVersion === "2" || req.query?.cursor !== undefined;
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  pageLimit,
  encodeCursor,
  decodeCursor,
  withCursor,
  pageResult,
  wantsEnvelope,
};
