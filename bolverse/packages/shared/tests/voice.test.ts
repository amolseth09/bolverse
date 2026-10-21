import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceSource } from "../src/index";

test("female chosen: server voice when the server offers female", () => {
  assert.equal(voiceSource(["female", "male"], "female"), "server");
});
test("male chosen: server voice when the server offers male", () => {
  assert.equal(voiceSource(["female", "male"], "male"), "server");
});
test("chosen gender missing on the server: device voice (the old bug played the server's single male voice)", () => {
  assert.equal(voiceSource(["any"], "female"), "device");
  assert.equal(voiceSource(["male"], "female"), "device");
  assert.equal(voiceSource(["female"], "male"), "device");
});
test("no gender chosen: any server voice is fine", () => {
  assert.equal(voiceSource(["any"], null), "server");
});
test("no server voice: device voice", () => {
  assert.equal(voiceSource([], "male"), "device");
});
