# Cerberus IDE — Windows Build Talimatı

VSCodium fork'u baz alınarak Cerberus brand'i ile derlenecek. Tüm script'ler Bash, o yüzden Windows'ta **Git Bash** içinde çalıştırılmalı.

---

## 1. Gereksinimler

Bir kez kur, hepsi `winget` ile gelir:

```cmd
winget install --id Git.Git -e
winget install --id Python.Python.3.11 -e
winget install --id jqlang.jq -e
winget install --id 7zip.7zip -e
winget install --id Rustlang.Rustup -e
```

**Node.js**: bu projenin `.nvmrc`'sindeki sürüm. [nvm-windows](https://github.com/coreybutler/nvm-windows) kur, sonra:

```cmd
nvm install 20.18.1
nvm use 20.18.1
```

**Visual Studio Build Tools 2022** (C++ workload): native modül derlemek için zorunlu. Node installer'da "Automatically install the necessary tools" kutusunu işaretlersen otomatik gelir.

**WiX Toolset v3** (sadece `.msi` üreteceksen): https://wixtoolset.org/releases/

---

## 2. PATH doğrulaması

Git Bash aç ve sırayla çalıştır:

```bash
node --version          # 20.x olmalı
npm --version
jq --version
python3 --version       # 3.11.x
cargo --version
git --version
```

Hepsi cevap vermiyorsa **System Properties → Environment Variables → Path** üzerinden ekle, terminali kapat-aç.

---

## 3. Brand değişkenlerini yükle

Repo kökünde:

```bash
cd /c/path/to/vscodium
source brand.env
```

`brand.env` içeriği:

```bash
APP_NAME=Cerberus
BINARY_NAME=cerberus
ORG_NAME=AiwebModel
GH_REPO_PATH=aiwebmodel/cerberus
CERBERUS_AI_API_BASE_URL=https://ide.aiwebmodel.com
CERBERUS_HOMEPAGE_URL=https://ide.aiwebmodel.com
```

Değiştirmek istersen `source` etmeden önce dosyayı düzenle.

---

## 4. Build env'lerini ayarla

```bash
export VSCODE_QUALITY="stable"
export OS_NAME="windows"
export VSCODE_ARCH="x64"            # x64 / arm64
export RELEASE_VERSION="0.1.0"
export SHOULD_BUILD="yes"
export SHOULD_BUILD_REH="no"        # remote extension host paketi gereksiz ise
export DISABLE_UPDATE="yes"         # ilk denemede update server koşullarını atla
export CI_BUILD="no"
```

---

## 5. VS Code kaynağını çek

```bash
./get_repo.sh
```

Bu script `vscode/` klasörünü oluşturur (`microsoft/vscode`'un belirli bir tag'i, VSCodium ile uyumlu).

---

## 6. Build

```bash
./build.sh
```

İçeride:
1. `prepare_vscode.sh` → brand env'leri ile `product.json`'u override eder, Cerberus master patch'lerini uygular, **`extensions/cerberus-ai`** built-in extension'ımızı `vscode/extensions/`'a kopyalar.
2. `npm ci` ile bağımlılıkları kurar (uzun sürer, bir kez 5-15 dk).
3. Electron + native modüller derlenir.
4. `vscode/.build/` altında çıktılar oluşur.

Hata olursa `vscode/.build/build.log` dosyasına bak.

---

## 7. Paketleyici (installer / archive)

Build'in sonunda:

```bash
./prepare_assets.sh        # ZIP, Inno Setup ve isteğe bağlı .msi üretir
```

Çıktılar `assets/` klasörüne düşer. İlginç olanlar:

| Dosya | Ne için |
| --- | --- |
| `Cerberus-Setup-x64-0.1.0.exe` | Inno Setup installer |
| `Cerberus-x64-0.1.0.zip` | Portable archive |
| `Cerberus-x64-0.1.0.msi` | (WiX yüklüyse) MSI |

---

## 8. Hızlı geliştirici çalıştırma (build kontrolü)

İlk kez çalıştırırken `dev/build.sh` kullanmak daha kolay:

```bash
./dev/build.sh           # tam dev build, vscode/ üzerinde watcher hazır
```

Sonra başka bir Git Bash'te:

```bash
cd vscode
npm run watch     # arka planda derler
./scripts/code.sh # geliştirici Cerberus penceresi açılır
```

---

## 9. Cerberus AI'yi panele bağlamak

İlk başlatmada Cerberus penceresi açılır → Komut paleti `Ctrl+Shift+P` → **"Cerberus AI: Sign In"**. İki seçenek:

- **Kullanıcı adı + parola**: panele kullanıcıyla giriş yapar, JWT token'ı `SecretStorage`'a kaydeder.
- **API token**: panel → Profilim → "API Token" değerini yapıştır.

Sonra `Cerberus AI: Refresh Models` çalıştır → `/api/models` çekilir, modeller VS Code Language Model API'a kaydedilir. Chat panel veya inline-completion bu modellerden birini seçince istek `https://ide.aiwebmodel.com/api/ai/chat` adresine düşer.

---

## 10. Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| `python: command not found` | Python 3.11 kurulu mu? PATH'te mi? Git Bash'i yeniden başlat. |
| `gyp ERR! find VS` | VS Build Tools 2022 → C++ workload yüklü mü? `npm config set msvs_version 2022` |
| `EACCES` veya kilit hatası | Antivirus repo klasörünü tarıyor; `vscode/`'yi exclude listesine ekle. |
| Build %50'de takılıyor | İlk `npm ci` 10+ dk sürebilir; sabret, `tail -f vscode/.build/build.log` ile izle. |
| `npm error code 127 sed -i` | Git Bash kullanmıyorsun. PowerShell veya CMD ile başlatma — `bash ./build.sh` |

---

## 11. Build sonrası: panele yükleme

Çıkan `.exe` veya `.zip`'i panel → **Güncellemeler** sekmesinden yükle, `version=0.1.0`, channel=`stable`, platform=`win32-x64`, "Yayınla" işaretle. Cerberus IDE çalışır çalışmaz `/api/update/check` ile yeni sürümü görüp kullanıcıyı bilgilendirir.
