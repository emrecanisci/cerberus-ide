#!/usr/bin/env bash
# shellcheck disable=SC1091,2154

set -e

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  cp -rp src/insider/* vscode/
else
  cp -rp src/stable/* vscode/
fi

cp -f LICENSE vscode/LICENSE.txt

cd vscode || { echo "'vscode' dir not found"; exit 1; }

rm -rf extensions/copilot

{ set +x; } 2>/dev/null

# {{{ product.json
cp product.json{,.bak}

setpath() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --arg 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath_json() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --argjson 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

# Brand-aware static URLs (overridable from env)
: "${CERBERUS_HOMEPAGE_URL:=https://cerberus.aiwebmodel.com}"
: "${CERBERUS_DOCS_URL:=${CERBERUS_HOMEPAGE_URL}/docs}"
: "${CERBERUS_ISSUES_URL:=https://github.com/${GH_REPO_PATH}/issues/new}"
: "${CERBERUS_LICENSE_URL:=https://github.com/${GH_REPO_PATH}/blob/master/LICENSE}"
: "${CERBERUS_RELEASES_URL:=https://github.com/${GH_REPO_PATH}/releases}"
: "${CERBERUS_AI_API_BASE_URL:=https://api.aiwebmodel.com/v1}"

setpath "product" "checksumFailMoreInfoUrl" "${CERBERUS_DOCS_URL}/checksum"
setpath "product" "documentationUrl" "${CERBERUS_DOCS_URL}"
setpath_json "product" "extensionsGallery" '{"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}'

setpath "product" "introductoryVideosUrl" "${CERBERUS_DOCS_URL}/videos"
setpath "product" "keyboardShortcutsUrlLinux" "${CERBERUS_DOCS_URL}/shortcuts/linux"
setpath "product" "keyboardShortcutsUrlMac" "${CERBERUS_DOCS_URL}/shortcuts/mac"
setpath "product" "keyboardShortcutsUrlWin" "${CERBERUS_DOCS_URL}/shortcuts/windows"
setpath "product" "licenseUrl" "${CERBERUS_LICENSE_URL}"
setpath_json "product" "linkProtectionTrustedDomains" "[\"https://open-vsx.org\", \"${CERBERUS_HOMEPAGE_URL}\", \"${CERBERUS_AI_API_BASE_URL%/v1}\"]"
setpath "product" "releaseNotesUrl" "${CERBERUS_DOCS_URL}/release-notes"
setpath "product" "reportIssueUrl" "${CERBERUS_ISSUES_URL}"
setpath "product" "requestFeatureUrl" "${CERBERUS_DOCS_URL}/feature-requests"
setpath "product" "tipsAndTricksUrl" "${CERBERUS_DOCS_URL}/tips"
setpath "product" "twitterUrl" "${CERBERUS_HOMEPAGE_URL}"

if [[ "${DISABLE_UPDATE}" != "yes" ]]; then
  setpath "product" "updateUrl" "https://raw.githubusercontent.com/${GH_REPO_PATH}/versions/refs/heads/master"
  setpath "product" "downloadUrl" "${CERBERUS_RELEASES_URL}"
fi

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "product" "nameShort" "Cerberus - Insiders"
  setpath "product" "nameLong" "Cerberus - Insiders"
  setpath "product" "applicationName" "cerberus-insiders"
  setpath "product" "dataFolderName" ".cerberus-insiders"
  setpath "product" "linuxIconName" "cerberus-insiders"
  setpath "product" "quality" "insider"
  setpath "product" "urlProtocol" "cerberus-insiders"
  setpath "product" "serverApplicationName" "cerberus-server-insiders"
  setpath "product" "serverDataFolderName" ".cerberus-server-insiders"
  setpath "product" "darwinBundleIdentifier" "com.aiwebmodel.CerberusInsiders"
  setpath "product" "win32AppUserModelId" "AiwebModel.CerberusInsiders"
  setpath "product" "win32DirName" "Cerberus Insiders"
  setpath "product" "win32MutexName" "cerberusinsiders"
  setpath "product" "win32NameVersion" "Cerberus Insiders"
  setpath "product" "win32RegValueName" "CerberusInsiders"
  setpath "product" "win32ShellNameShort" "Cerberus Insiders"
  setpath "product" "win32AppId" "{{EF35BB36-FA7E-4BB9-B7DA-D1E09F2DA9C9}"
  setpath "product" "win32x64AppId" "{{B2E0DDB2-120E-4D34-9F7E-8C688FF839A2}"
  setpath "product" "win32arm64AppId" "{{44721278-64C6-4513-BC45-D48E07830599}"
  setpath "product" "win32UserAppId" "{{ED2E5618-3E7E-4888-BF3C-A6CCC84F586F}"
  setpath "product" "win32x64UserAppId" "{{20F79D0D-A9AC-4220-9A81-CE675FFB6B41}"
  setpath "product" "win32arm64UserAppId" "{{2E362F92-14EA-455A-9ABD-3E656BBBFE71}"
  setpath "product" "tunnelApplicationName" "cerberus-insiders-tunnel"
  setpath "product" "win32TunnelServiceMutex" "cerberusinsiders-tunnelservice"
  setpath "product" "win32TunnelMutex" "cerberusinsiders-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "90AAD229-85FD-43A3-B82D-8598A88829CF"
  setpath "product" "win32ContextMenu.arm64.clsid" "7544C31C-BDBF-4DDF-B15E-F73A46D6723D"
else
  setpath "product" "nameShort" "Cerberus"
  setpath "product" "nameLong" "Cerberus"
  setpath "product" "applicationName" "cerberus"
  setpath "product" "linuxIconName" "cerberus"
  setpath "product" "quality" "stable"
  setpath "product" "urlProtocol" "cerberus"
  setpath "product" "serverApplicationName" "cerberus-server"
  setpath "product" "serverDataFolderName" ".cerberus-server"
  setpath "product" "darwinBundleIdentifier" "com.aiwebmodel.Cerberus"
  setpath "product" "win32AppUserModelId" "AiwebModel.Cerberus"
  setpath "product" "win32DirName" "Cerberus"
  setpath "product" "win32MutexName" "cerberus"
  setpath "product" "win32NameVersion" "Cerberus"
  setpath "product" "win32RegValueName" "Cerberus"
  setpath "product" "win32ShellNameShort" "Cerberus"
  setpath "product" "win32AppId" "{{763CBF88-25C6-4B10-952F-326AE657F16B}"
  setpath "product" "win32x64AppId" "{{88DA3577-054F-4CA1-8122-7D820494CFFB}"
  setpath "product" "win32arm64AppId" "{{67DEE444-3D04-4258-B92A-BC1F0FF2CAE4}"
  setpath "product" "win32UserAppId" "{{0FD05EB4-651E-4E78-A062-515204B47A3A}"
  setpath "product" "win32x64UserAppId" "{{2E1F05D1-C245-4562-81EE-28188DB6FD17}"
  setpath "product" "win32arm64UserAppId" "{{57FD70A5-1B8D-4875-9F40-C5553F094828}"
  setpath "product" "tunnelApplicationName" "cerberus-tunnel"
  setpath "product" "win32TunnelServiceMutex" "cerberus-tunnelservice"
  setpath "product" "win32TunnelMutex" "cerberus-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "D910D5E6-B277-4F4A-BDC5-759A34EEE25D"
  setpath "product" "win32ContextMenu.arm64.clsid" "4852FC55-4A84-4EA1-9C86-D53BE3DF83C0"
fi

setpath_json "product" "tunnelApplicationConfig" '{}'

# Cerberus AI provider config (consumed by built-in cerberus-ai extension)
setpath "product" "cerberusAiApiBaseUrl" "${CERBERUS_AI_API_BASE_URL}"
setpath "product" "cerberusAiHomepageUrl" "${CERBERUS_HOMEPAGE_URL}"
setpath_json "product" "cerberusAiDefaultModels" '[{"id":"cerberus-coder","label":"Cerberus Coder","family":"cerberus","capabilities":["chat","completions"]},{"id":"cerberus-thinker","label":"Cerberus Thinker","family":"cerberus","capabilities":["chat"]}]'

jsonTmp=$( jq -s '.[0] * .[1]' product.json ../product.json )
echo "${jsonTmp}" > product.json && unset jsonTmp

cat product.json
# }}}

# include common functions
. ../utils.sh

# {{{ apply patches

echo "APP_NAME=\"${APP_NAME}\""
echo "APP_NAME_LC=\"${APP_NAME_LC}\""
echo "ASSETS_REPOSITORY=\"${ASSETS_REPOSITORY}\""
echo "BINARY_NAME=\"${BINARY_NAME}\""
echo "GH_REPO_PATH=\"${GH_REPO_PATH}\""
echo "GLOBAL_DIRNAME=\"${GLOBAL_DIRNAME}\""
echo "ORG_NAME=\"${ORG_NAME}\""
echo "TUNNEL_APP_NAME=\"${TUNNEL_APP_NAME}\""

if [[ "${DISABLE_UPDATE}" == "yes" ]]; then
  mv ../patches/00-update-disable.patch.yet ../patches/00-update-disable.patch
fi

for file in ../patches/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  for file in ../patches/insider/*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

if [[ -d "../patches/${OS_NAME}/" ]]; then
  for file in "../patches/${OS_NAME}/"*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

for file in ../patches/user/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done
# }}}

set -x

# {{{ install dependencies
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [[ "${OS_NAME}" == "linux" ]]; then
  export VSCODE_SKIP_NODE_VERSION_CHECK=1

   if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
elif [[ "${OS_NAME}" == "windows" ]]; then
  if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
else
  if [[ "${CI_BUILD}" != "no" ]]; then
    clang++ --version
  fi
fi

node build/npm/preinstall.ts

mv .npmrc .npmrc.bak
cp ../npmrc .npmrc

for i in {1..5}; do # try 5 times
  if [[ "${CI_BUILD}" != "no" && "${OS_NAME}" == "osx" ]]; then
    CXX=clang++ npm ci && break
  else
    npm ci && break
  fi

  if [[ $i == 5 ]]; then
    echo "Npm install failed too many times" >&2
    exit 1
  fi
  echo "Npm install failed $i, trying again..."

  sleep $(( 15 * (i + 1)))
done

mv .npmrc.bak .npmrc
# }}}

# bring built-in Cerberus extensions into vscode/extensions before build
if [[ -d "../extensions" ]]; then
  for ext_dir in ../extensions/*/; do
    [[ -d "${ext_dir}" ]] || continue
    ext_name="$(basename "${ext_dir}")"
    echo "Copying built-in extension: ${ext_name}"
    rm -rf "extensions/${ext_name}"
    cp -rp "${ext_dir}" "extensions/${ext_name}"
  done
fi

# package.json
cp package.json{,.bak}

setpath "package" "version" "${RELEASE_VERSION%-insider}"

replace "s|Microsoft Corporation|${ORG_NAME}|" package.json

cp resources/server/manifest.json{,.bak}

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "resources/server/manifest" "name" "Cerberus - Insiders"
  setpath "resources/server/manifest" "short_name" "Cerberus - Insiders"
else
  setpath "resources/server/manifest" "name" "Cerberus"
  setpath "resources/server/manifest" "short_name" "Cerberus"
fi

# announcements
replace "s|\\[\\/\\* BUILTIN_ANNOUNCEMENTS \\*\\/\\]|$( tr -d '\n' < ../announcements-builtin.json )|" src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts

../undo_telemetry.sh

replace "s|Microsoft Corporation|${ORG_NAME}|" build/lib/electron.ts
replace "s|([0-9]) Microsoft|\\1 ${ORG_NAME}|" build/lib/electron.ts

if [[ "${OS_NAME}" == "linux" ]]; then
  # Microsoft would otherwise inject their apt repo unless the binary name
  # differs from code-oss. Our binary is ${BINARY_NAME}, so swap it in.
  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    sed -i "s/code-oss/${BINARY_NAME}-insiders/" resources/linux/debian/postinst.template
  else
    sed -i "s/code-oss/${BINARY_NAME}/" resources/linux/debian/postinst.template
  fi

  # fix the packages metadata
  # code.appdata.xml
  sed -i "s|Visual Studio Code|${APP_NAME}|g" resources/linux/code.appdata.xml
  sed -i "s|https://code.visualstudio.com/docs/setup/linux|${CERBERUS_DOCS_URL}/install|" resources/linux/code.appdata.xml
  sed -i "s|https://code.visualstudio.com/home/home-screenshot-linux-lg.png|${CERBERUS_HOMEPAGE_URL}/img/cerberus.png|" resources/linux/code.appdata.xml
  sed -i "s|https://code.visualstudio.com|${CERBERUS_HOMEPAGE_URL}|" resources/linux/code.appdata.xml

  # control.template
  sed -i "s|Microsoft Corporation <vscode-linux@microsoft.com>|${ORG_NAME} <support@aiwebmodel.com>|"  resources/linux/debian/control.template
  sed -i "s|Visual Studio Code|${APP_NAME}|g" resources/linux/debian/control.template
  sed -i "s|https://code.visualstudio.com/docs/setup/linux|${CERBERUS_DOCS_URL}/install|" resources/linux/debian/control.template
  sed -i "s|https://code.visualstudio.com|${CERBERUS_HOMEPAGE_URL}|" resources/linux/debian/control.template

  # code.spec.template
  sed -i "s|Microsoft Corporation|${ORG_NAME}|" resources/linux/rpm/code.spec.template
  sed -i "s|Visual Studio Code Team <vscode-linux@microsoft.com>|${ORG_NAME} <support@aiwebmodel.com>|" resources/linux/rpm/code.spec.template
  sed -i "s|Visual Studio Code|${APP_NAME}|" resources/linux/rpm/code.spec.template
  sed -i "s|https://code.visualstudio.com/docs/setup/linux|${CERBERUS_DOCS_URL}/install|" resources/linux/rpm/code.spec.template
  sed -i "s|https://code.visualstudio.com|${CERBERUS_HOMEPAGE_URL}|" resources/linux/rpm/code.spec.template
elif [[ "${OS_NAME}" == "windows" ]]; then
  # code.iss
  sed -i "s|https://code.visualstudio.com|${CERBERUS_HOMEPAGE_URL}|" build/win32/code.iss
  sed -i "s|Microsoft Corporation|${ORG_NAME}|" build/win32/code.iss
fi

cd ..
