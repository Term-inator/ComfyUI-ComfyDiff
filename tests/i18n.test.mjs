import assert from "node:assert/strict";
import { test } from "node:test";
import { apiError, setLocale, t } from "../web/i18n.js";
import en from "../web/locales/en.js";
import zh from "../web/locales/zh.js";

test("both catalogs provide the same messages and template parameters", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const parameters = (message) => [...new Set(message.match(/\{\w+\}/g) ?? [])].sort();
  for (const [key, message] of Object.entries(en)) {
    assert.ok(zh[key].trim(), key);
    assert.deepEqual(parameters(zh[key]), parameters(message), key);
  }
});

test("repository errors translate the version label and preserve Git diagnostics", () => {
  const detail = "fatal: could not read refs/heads/feature";
  const error = { error: "error.readGitBlob", source: "version.index", detail };
  setLocale("zh");
  assert.equal(apiError(error), `无法读取暂存版本的工作流。\n${detail}`);
  setLocale("en");
  assert.equal(apiError(error), `Staged version: could not read the workflow.\n${detail}`);
  setLocale("fr");
  assert.equal(t("diff.title"), "Workflow Diff");
});
