//go:build !noprint
// +build !noprint

package securelog

func Install(_ string) {}

func SnapshotLogs(_ uint64, _ int) Snapshot {
	return Snapshot{Enabled: false, Error: "secure client logs are not enabled for this build"}
}
