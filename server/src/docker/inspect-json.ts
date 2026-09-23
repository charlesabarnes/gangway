export type PortBindingJson = { HostIp?: string | undefined; HostPort?: string | undefined };

export type InspectJson = {
  Id?: string | undefined;
  Name?: string | undefined;
  Created?: string | undefined;
  Image?: string | undefined;
  Config?:
    { Image?: string | undefined; Labels?: Record<string, string> | null | undefined } | undefined;
  State?:
    | {
        Status?: string | undefined;
        Running?: boolean | undefined;
        ExitCode?: number | undefined;
        StartedAt?: string | undefined;
        FinishedAt?: string | undefined;
        Health?:
          { Status?: string | undefined; FailingStreak?: number | undefined } | null | undefined;
      }
    | undefined;
  NetworkSettings?:
    { Ports?: Record<string, PortBindingJson[] | null> | null | undefined } | undefined;
};
