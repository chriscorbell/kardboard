import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Docker from "dockerode";
import { pruneSupersededImages, SOURCE_LABEL, supersededImageFilters } from "../src/images.js";

const SOURCE = "https://github.com/chriscorbell/kardboard";

describe("pruning the agent images a pull left behind", () => {
  it("prunes only untagged images built from the same repository", () => {
    assert.deepEqual(supersededImageFilters({ [SOURCE_LABEL]: SOURCE }), { dangling: ["true"], label: [`${SOURCE_LABEL}=${SOURCE}`] });
  });

  it("leaves everything alone for an image that does not say where it came from", async () => {
    assert.equal(supersededImageFilters({}), null);
    assert.equal(supersededImageFilters(undefined), null);
    let pruned = false;
    const docker = {
      getImage: () => ({ inspect: async () => ({ Config: { Labels: {} } }) }),
      pruneImages: async () => {
        pruned = true;
        return {};
      },
    } as unknown as Docker;
    assert.equal(await pruneSupersededImages(docker, "board/override:latest"), 0);
    assert.equal(pruned, false, "another stack's dangling images are not this runner's to remove");
  });

  it("asks Docker with the filters and counts what it removed", async () => {
    let asked: unknown;
    const docker = {
      getImage: () => ({ inspect: async () => ({ Config: { Labels: { [SOURCE_LABEL]: SOURCE } } }) }),
      pruneImages: async (opts: unknown) => {
        asked = opts;
        return { ImagesDeleted: [{ Untagged: "x" }, { Deleted: "sha256:old" }] };
      },
    } as unknown as Docker;
    assert.equal(await pruneSupersededImages(docker, "ghcr.io/chriscorbell/kardboard-agent:latest"), 2);
    assert.deepEqual(asked, { filters: { dangling: ["true"], label: [`${SOURCE_LABEL}=${SOURCE}`] } });
  });
});
