import { describe, expect, it } from "vitest";
import {
  computeChannelRuntimeStatus,
  isChannelRuntimeConnected,
} from "../../electron/utils/channel-status";

describe("channel status connection heuristics", () => {
  it("does not treat a merely running channel as connected", () => {
    const account = {
      running: true,
      connected: false,
      linked: false,
      lastError: null,
      lastConnectedAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      probe: { ok: true },
    };

    expect(isChannelRuntimeConnected(account)).toBe(false);
    expect(computeChannelRuntimeStatus(account)).toBe("connecting");
  });

  it("treats recent traffic as a real connection signal", () => {
    const now = Date.now();
    const account = {
      running: true,
      connected: false,
      linked: false,
      lastError: null,
      lastConnectedAt: now,
      lastInboundAt: now,
      lastOutboundAt: null,
      probe: null,
    };

    expect(isChannelRuntimeConnected(account)).toBe(true);
    expect(computeChannelRuntimeStatus(account)).toBe("connected");
  });
});
