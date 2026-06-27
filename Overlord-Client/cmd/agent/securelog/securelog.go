package securelog

type Entry struct {
	Seq    uint64 `msgpack:"seq" json:"seq"`
	At     int64  `msgpack:"at" json:"at"`
	Source string `msgpack:"source" json:"source"`
	Blob   string `msgpack:"blob" json:"blob"`
}

type Snapshot struct {
	Entries []Entry
	Dropped uint64
	FromSeq uint64
	ToSeq   uint64
	Enabled bool
	Error   string
}
