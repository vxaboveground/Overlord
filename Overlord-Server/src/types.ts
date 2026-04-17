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
  inMemory?: boolean;
  cpu?: string;
  gpu?: string;
  ram?: string;
  isAdmin?: boolean;
  elevation?: string;
  permissions?: Record<string, boolean>;
  enrollmentStatus?: EnrollmentStatus;
  buildTag?: string;
  builtByUserId?: number;
  publicKey?: string;
  keyFingerprint?: string;
  disconnectReason?: string;
  disconnectDetail?: string;
  groupId?: number | null;
  groupName?: string | null;
  groupColor?: string | null;
  lastResourceUsage?: Record<string, any>;
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
  builtByUserId?: number;
  requireBuildOwner?: boolean;
  allowedClientIds?: string[];
  deniedClientIds?: string[];
  groupFilter?: string;
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
