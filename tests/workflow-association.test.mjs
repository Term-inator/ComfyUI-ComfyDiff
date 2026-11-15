import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileAssociation } from "../web/workflow-association.js";

test("a matched file stays associated when missing and can be replaced by an explicit choice", () => {
  const workspace = "/checkout";
  const match = { workspace, file: "flow.json", source: "match" };
  const missing = { workspace, file: null, source: null };
  const chosen = { workspace, file: "other.json", source: "binding" };

  assert.deepEqual(reconcileAssociation(missing, match), match);
  assert.deepEqual(reconcileAssociation(chosen, match), chosen);
  assert.deepEqual(reconcileAssociation(missing, { ...match, workspace: "/another" }), missing);
});
