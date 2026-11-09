import { describe, expect, it } from "vitest";
import { hasNetworkLink } from "./daemon-runtime.mjs";

const loopback = [
	{ address: "127.0.0.1", family: "IPv4", internal: true },
	{ address: "::1", family: "IPv6", internal: true },
];

describe("hasNetworkLink", () => {
	it("counts Wi-Fi or Ethernet with a routable address", () => {
		expect(
			hasNetworkLink({ lo0: loopback, en0: [{ address: "192.168.0.12", family: "IPv4", internal: false }] }, "darwin"),
		).toBe(true);
		expect(hasNetworkLink({ en5: [{ address: "2001:db8::5", family: "IPv6", internal: false }] }, "darwin")).toBe(true);
	});

	it("finds no link on a Mac that just woke, even with a VPN tunnel still up", () => {
		const justWoke = {
			lo0: loopback,
			utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
			en0: [{ address: "fe80::1c4f:8aff:fe12:3456", family: "IPv6", internal: false }],
		};
		expect(hasNetworkLink(justWoke, "darwin")).toBe(false);
		expect(hasNetworkLink({ en0: [{ address: "169.254.10.2", family: "IPv4", internal: false }] }, "darwin")).toBe(
			false,
		);
		expect(hasNetworkLink({ en0: [{ address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false }] }, "darwin")).toBe(
			false,
		);
	});

	it("leaves other platforms running jobs as before", () => {
		expect(hasNetworkLink({}, "linux")).toBe(true);
	});
});
