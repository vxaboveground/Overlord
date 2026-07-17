package handlers

import "testing"

func TestParseICEServers(t *testing.T) {
	servers := parseICEServers([]interface{}{
		map[string]interface{}{"urls": []interface{}{"stun:turn.example.test:3478"}},
		map[string]interface{}{
			"urls":       []interface{}{"turn:turn.example.test:3478?transport=udp", "turn:turn.example.test:3478?transport=tcp", "https://invalid.example"},
			"username":   "expiry:agent",
			"credential": "derived-secret",
		},
	})
	if len(servers) != 2 {
		t.Fatalf("server count = %d, want 2", len(servers))
	}
	if len(servers[1].URLs) != 2 {
		t.Fatalf("TURN URL count = %d, want 2", len(servers[1].URLs))
	}
	if servers[1].Username != "expiry:agent" || servers[1].Credential != "derived-secret" {
		t.Fatal("TURN credentials were not preserved")
	}
}

func TestParseICEServersRejectsInvalidInput(t *testing.T) {
	servers := parseICEServers([]interface{}{
		map[string]interface{}{"urls": "https://not-an-ice-server"},
		"invalid",
	})
	if len(servers) != 0 {
		t.Fatalf("server count = %d, want 0", len(servers))
	}
}
