export type ClientRole = "client" | "viewer";

export type EnrollmentStatus = "pending" | "approved" | "denied";

export type ClientInfo = {
  id: string;
  lastSeen: number;
  role: ClientRole;
  ws: any;
  lastPingSent?: number;
  lastPingNonce?: number;
  online?: boolean;
  hwid?: string;
  ip?: string;
  host?: string;
  os?: string;
  arch?: string;
  version?: string;
  user?: string;
  nickname?: string;
  customTag?: string;
  customTagNote?: string;
  monitors?: number;
  monitorInfo?: { width: number; height: number }[];
  country?: string;
  pingMs?: number;
  enrollmentStatus?: EnrollmentStatus;
  publicKey?: string;
  keyFingerprint?: string;
  cryptoWallets?: string[] | null;
};

export type ListFilters = {
  page: number;
  pageSize: number;
  search: string;
  sort: string;
  statusFilter?: string;
  osFilter?: string;
  countryFilter?: string;
  enrollmentFilter?: string;
  allowedClientIds?: string[];
  deniedClientIds?: string[];
};

export type ListItem = ClientInfo & {
  online: boolean;
  thumbnail: string | null;
};

export type ListResult = {
  page: number;
  pageSize: number;
  total: number;
  online: number;
  items: ListItem[];
};
