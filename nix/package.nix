{
  lib,
  stdenv,
  bun,
  nodejs-slim_22,
  makeWrapper,
  autoPatchelfHook,
  writableTmpDirAsHomeHook,
  alacritty,
}:

let
  packageJson = lib.importJSON ../package.json;

  inherit (stdenv.hostPlatform) isLinux isDarwin;

  # npm platform names, as used by package.json `os`/`cpu` and onnxruntime-node's bin layout.
  npmOs =
    if isLinux then
      "linux"
    else if isDarwin then
      "darwin"
    else
      throw "speak-harness: unsupported OS ${stdenv.hostPlatform.system}";
  npmCpu =
    if stdenv.hostPlatform.isx86_64 then
      "x64"
    else if stdenv.hostPlatform.isAarch64 then
      "arm64"
    else
      throw "speak-harness: unsupported CPU ${stdenv.hostPlatform.system}";
  npmLibc = lib.optionalString isLinux "glibc";

  # Runtime JS dependencies from bun.lock. Installed for every supported platform so the
  # output hash is identical on all systems; the package prunes it to the host platform.
  nodeModules = stdenv.mkDerivation {
    pname = "speak-harness-node_modules";
    version = packageJson.version;

    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../bun.lock
      ];
    };

    strictDeps = true;
    nativeBuildInputs = [
      bun
      writableTmpDirAsHomeHook
    ];

    impureEnvVars = lib.fetchers.proxyImpureEnvVars;

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild

      export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
      bun install \
        --frozen-lockfile \
        --production \
        --ignore-scripts \
        --no-progress \
        --os=linux --os=darwin \
        --cpu=x64 --cpu=arm64

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp -R node_modules $out/

      runHook postInstall
    '';

    # A fixed-output derivation must not reference store paths.
    dontFixup = true;

    outputHash = "sha256-2X/kQgaF2FT3JeRAnNci/h66xoy318TZdL7LYxPeGxE=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
stdenv.mkDerivation {
  pname = "speak-harness";
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../tsconfig.json
      ../src
    ];
  };

  strictDeps = true;
  nativeBuildInputs = [
    bun
    makeWrapper
  ]
  ++ lib.optional isLinux autoPatchelfHook;

  # libstdc++ for the prebuilt onnxruntime-node and sharp binaries.
  buildInputs = lib.optional isLinux stdenv.cc.cc.lib;

  dontConfigure = true;
  dontBuild = true;
  # Prebuilt vendor binaries; stripping them gains little and risks breaking them.
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    app=$out/lib/speak-harness
    mkdir -p $app
    cp -R package.json tsconfig.json src $app/
    cp -R ${nodeModules}/node_modules $app/
    chmod -R u+w $app/node_modules

    bun ${./prune-node-modules.ts} $app/node_modules ${npmOs} ${npmCpu} ${npmLibc}

    # onnxruntime-node ships every platform's binding inside one package.
    find $app/node_modules/onnxruntime-node/bin/napi-v3 -mindepth 1 -maxdepth 1 \
      ! -name ${npmOs} -exec rm -rf {} +
    find $app/node_modules/onnxruntime-node/bin/napi-v3/${npmOs} -mindepth 1 -maxdepth 1 \
      ! -name ${npmCpu} -exec rm -rf {} +

    # bun runs the CLI; the TTS worker needs Node >= 22.18 (type stripping) from PATH.
    makeWrapper ${lib.getExe bun} $out/bin/speakh \
      --add-flags $app/src/cli/main.ts \
      --prefix PATH : ${
        lib.makeBinPath [
          bun
          nodejs-slim_22
        ]
      } ${lib.optionalString isLinux "--prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]}"}
    ${lib.optionalString isLinux ''
      # Browser dashboard is the primary graphical entry; keep the terminal interface separately.
      mkdir -p $out/share/applications
      printf '%s\n' \
        '[Desktop Entry]' \
        'Type=Application' \
        'Name=SpeakHarness' \
        'Comment=Open the local SpeakHarness listening dashboard' \
        "Exec=$out/bin/speakh web" \
        'Terminal=false' \
        'Icon=audio-speakers' \
        'Categories=Utility;Audio;' \
        > $out/share/applications/speak-harness.desktop
      printf '%s\n' \
        '[Desktop Entry]' \
        'Type=Application' \
        'Name=SpeakHarness Terminal' \
        'Comment=Open the OpenTUI interface in Alacritty' \
        "Exec=${lib.getExe alacritty} -e $out/bin/speakh" \
        'Terminal=false' \
        'Icon=utilities-terminal' \
        'Categories=Utility;Audio;' \
        > $out/share/applications/speak-harness-terminal.desktop
    ''}

    runHook postInstall
  '';

  passthru = {
    node_modules = nodeModules;
  };

  meta = {
    description = "Read AI coding-harness answers aloud from a terminal UI, locally";
    homepage = "https://github.com/Matheuscara/speak-harness";
    # SpeakHarness is MIT; the bundled eSpeak-NG phonemizer (ephone) is GPL-3.0-or-later.
    license = with lib.licenses; [
      mit
      gpl3Plus
    ];
    mainProgram = "speakh";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
