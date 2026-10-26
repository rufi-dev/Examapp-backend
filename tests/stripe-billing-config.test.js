/* eslint-env node */
const assert = require("assert");
const fs = require("fs");

const stripeConfig = require("../config/stripe");
const userSource = fs.readFileSync(require.resolve("../models/userModel"), "utf8");
const serverSource = fs.readFileSync(require.resolve("../server"), "utf8");

assert.strictEqual(stripeConfig.planForPrice("price_unknown"), null);
assert.match(userSource, /stripeCustomerId/);
assert.match(userSource, /stripeSubscriptionStatus/);
assert.match(serverSource, /stripe\/webhook/);
assert.match(serverSource, /express\.raw\(\{ type: "application\/json" \}\)/);
assert.throws(() => stripeConfig.required("STRIPE_SECRET_KEY"), (error) => error.code === "stripe_not_configured");
assert.doesNotMatch(userSource, /sk_(?:live|test)_[A-Za-z0-9]+/);
console.log("stripe-billing-config: all assertions passed");
