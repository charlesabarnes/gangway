import { z } from "zod";

const port = z.int().min(1).max(65535);
const cap = z.int().min(1).nullable().default(null);

export const HostIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "a-z, 0-9, _ and -");

/** All of a host, each time: the same PUT twice changes nothing more. */
export const HostRegisterSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(64),
    dockerHost: z.string().trim().min(1).max(512),
    expectName: z.string().trim().min(1).max(255).nullable().default(null),
    capabilities: z
      .array(z.enum(["preview", "runner"]))
      .min(1)
      .max(2),
    publishBind: z.string().trim().min(1).max(64).default("127.0.0.1"),
    upstream: z.strictObject({
      dial: z.enum(["direct", "socks5"]).default("direct"),
      address: z.string().trim().min(1).max(255),
      proxy: z.string().trim().min(1).max(512).nullable().default(null),
    }),
    ports: z.strictObject({ rangeStart: port, rangeEnd: port }),
    orgId: z.string().min(1).nullable().default(null),
    capacity: z
      .strictObject({ memoryBytes: cap, maxPreviews: cap })
      .default({ memoryBytes: null, maxPreviews: null }),
  })
  .refine((h) => h.ports.rangeEnd >= h.ports.rangeStart, {
    message: "ports.rangeEnd is below ports.rangeStart",
    path: ["ports", "rangeEnd"],
  })
  .refine((h) => h.upstream.dial === "direct" || h.upstream.proxy !== null, {
    message: "a socks5 upstream needs its proxy",
    path: ["upstream", "proxy"],
  });
export type HostRegisterRequest = z.infer<typeof HostRegisterSchema>;
