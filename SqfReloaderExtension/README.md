# SqfReloader - REST API extension + mod for Arma 3

SqfReloader is a native Arma 3 extension (`SqfReloader_x64.dll`, NativeAOT) plus a small mod
(`@SqfReloader`) that lets external tools - editors, CI jobs, scripts - talk to a running
Arma 3 game or the Eden Editor over a local REST API.

The C# side was written from scratch; the SQF side only mirrors the message flow of
EdenOnline's scripts (extension call -> callback -> dispatch), it shares no code.

## Endpoints

| Method | Route | Body |
| --- | --- | --- |
| POST | `/api/command` | `{"type":"code"\|"recompile","code":"...","method":"..."}` (EdenOnline compatible) |
| POST | `/api/send` | `{"function":"MyEvent","data":[...]}` - calls the SQF handler registered for `MyEvent` |
| POST | `/api/eval` | `{"code":"systemChat 'hi'"}` - runs code inside Arma |
| POST | `/api/reload` | `{"functions":["MyTag_fnc_one"]}` or `{}` - recompiles `fn_*.sqf` from disk |
| POST | `/api/source` | `{"directory":"...\\@SqfReloader\\source"}` - points the DLL at the SQF sources |
| POST | `/api/log` | `{"level":"debug"}` |
| GET | `/api/status` | - |
| GET | `/api/functions` | - |

Default endpoint: `http://127.0.0.1:8765/api/` (config: `%LOCALAPPDATA%\SqfReloader\config.json`).

## Quick start

1. Run `tools\install.ps1` (right click -> *Run with PowerShell*):
   builds the DLL, packs the mod, installs `@SqfReloader`, writes the REST config and
   offers to add `-mod="@SqfReloader"` to the Steam launch options.
2. Start Arma 3 / Eden Editor with `@SqfReloader` enabled. No launch parameter is needed: the mod
   starts the API from its own `Cfg3DEN >> EventHandlers >> init`.
3. In the editor open *Tools > SqfReloader: Status*, or call
   `[] call SqfReloader_fnc_apiStart;` from a script.

```powershell
curl.exe -s http://127.0.0.1:8765/api/status
curl.exe -s -X POST http://127.0.0.1:8765/api/eval -H "Content-Type: application/json" -d "{\"code\":\"systemChat 'from REST'\"}"
```

## Layout

```text
SqfReloaderExtension/
├── SqfReloaderExtension.csproj      NativeAOT extension (output: SqfReloader_x64.dll)
├── exports.c                    RVExtensionFeatureFlags export (added to the NativeAOT .def)
├── linker.xml                   trimmer roots
├── src/Plugin/                  C# source of the DLL
│   ├── ArmaHost.cs              RVExtension* entry points + return buffer handling
│   ├── ExtensionHost.cs         callExtension dispatcher (sync / async keys)
│   ├── MessageQueue.cs          ordered outbox to Arma, batches bursts into BATCH callbacks
│   ├── RestApiServer.cs         HttpListener based REST API
│   ├── SimpleSerializer.cs      Arma literal (de)serialization
│   ├── SimpleJson.cs            reflection-free JSON reader/writer
│   └── ArmaLog.cs ...           logging, config
├── @SqfReloader/                mod sources, already in the shipped layout
│   ├── mod.cpp
│   ├── logo.paa
│   └── addons/scripts/          SQF sources (config.cpp, functions/)
├── tools/PboBuilder/            fallback PBO packer for machines without Arma 3 Tools
├── tools/ExportsProbe/          PE export checker used by the smoke test
├── tools/install.ps1            build + install
├── tools/build.ps1              build only (also creates the release zip with -Release)
├── tools/test-extension.ps1     Arma -> extension test with the callExtension harness
├── tools/install-call-extension.ps1   downloads the harness into tests/callExtension
├── tools/smoke-test.ps1         DLL + REST test without Arma
├── tools/check-sqf.ps1          SQF syntax / CfgFunctions check
├── tests/callExtension/         harness + sqfreloader_test.sqf (the SQF the harness executes)
├── dist/@SqfReloader/               generated mod (scripts.pbo + SqfReloader_x64.dll, same layout as the sources)
└── dist/SqfReloader-Setup.zip       distributable package (install.ps1 -NoBuild)
```

## Installer options

```text
tools\install.ps1 [-ArmaDir <path>] [-ModsDir <path>] [-Port 8765] [-HostName 127.0.0.1]
                  [-SkipLaunchOptions] [-NoBuild] [-Release] [-AddonBuilder <path>] [-NoVersionBump]
```

* `-ArmaDir` - Arma 3 folder; detected from the registry and Steam library folders.
* `-ModsDir` - where `@SqfReloader` is created (default: the Arma folder).
* `-NoBuild` - install the pre-built `dist\@SqfReloader` from a shipped zip.

What the installer does:

1. publishes the NativeAOT `SqfReloader_x64.dll`,
2. copies it next to `arma3_x64.exe` and `arma3server_x64.exe` (that is where Arma
   resolves extensions),
3. deploys `@SqfReloader` exactly as the sources are laid out (`mod.cpp`, `logo.paa`,
   `addons\scripts.pbo`), with the DLL in the mod root (Arma does not search a `dll\` subfolder).
4. keeps the plain `fn_*.sqf` sources in `@SqfReloader\source\` so the REST `recompile`
   command can hot-reload them without repacking,
5. writes `%LOCALAPPDATA%\SqfReloader\config.json` (host, port, source folder),
6. optionally adds `-mod="@SqfReloader"` to the Steam launch options for Arma 3.

Every build bumps the version by one patch level and writes it to `SqfReloaderExtension.csproj`,
`src\BuildStamp.cs` (what `/api/status` reports), `CfgPatches` in `config.cpp` and the VS Code
`package.json`. `-NoVersionBump` keeps the current number.

`tools\uninstall.ps1` reverses all of it.

## Requirements (build machine)

* .NET SDK 10 (`global.json` pins 10.0.100)
* Visual Studio 2022 Build Tools with *Desktop development with C++* (NativeAOT linker
  and the `exports.c` compile step)
* Arma 3 Tools (Steam > Library > Tools) only for the optional `-PackPbo` build

## SQF API

```sqf
[] call SqfReloader_fnc_init;                        // load the DLL, register ExtensionCallback
[] call SqfReloader_fnc_runStartup;                  // init + apiStart + mission StartupCode (Cfg3DEN runs this)
[] call SqfReloader_fnc_apiStart;                    // start REST API (port from config.json)
[9000, "127.0.0.1"] call SqfReloader_fnc_apiStart;   // explicit port/host
[] call SqfReloader_fnc_apiStatus;                   // HashMap: ready/version/url/port/running
[] call SqfReloader_fnc_diagnose;                    // one diag_log line per possible problem
[] call SqfReloader_fnc_reloadFunctions;             // recompile this mod's functions from disk
[["MyTag_fnc_name"]] call SqfReloader_fnc_reloadFunctions;
["MyEvent"] call SqfReloader_fnc_send;               // accept POST /api/send {"function":"MyEvent"}
[_port] call SqfReloader_fnc_apiStop;
```

Calling a C# method directly:

```sqf
private _result = ["Ping", ["hello"]] call SqfReloader_fnc_call;            // sync
private _async = ["FunctionIndex", [] , 5] call SqfReloader_fnc_callAsync;  // [_ok, _data]
```

### Reloading other mods' functions

Every custom function declared in `CfgFunctions` is available for recompile without a separate
allowlist in `CfgPatches`.

or push single functions through the API:

```powershell
curl.exe -s -X POST http://127.0.0.1:8765/api/reload -H "Content-Type: application/json" -d "{\"functions\":[\"MyTag_fnc_one\"]}"
```

`TAG_fnc_name` is resolved in `\z\<tag>\addons\<tag>\source\fn_name.sqf`,
`\z\<tag>\addons\<tag>\functions\fn_name.sqf`, `\x\<tag>\addons\...` and unpacked
`\@<tag>\addons\...` folders.

### Sending data into the game

```sqf
// once, at mission start
["MyEvent"] call SqfReloader_fnc_send;
missionNamespace setVariable ["SqfReloader_var_handler_MyEvent", { params ["_a"]; diag_log _a }];
```

```powershell
curl.exe -s -X POST http://127.0.0.1:8765/api/send -H "Content-Type: application/json" -d "{\"function\":\"MyEvent\",\"data\":[1,\"two\",[3,4],true,nil]}"
```

## Protocol notes

Every `callExtension` answer is `["CODE", [data]]`:

| code | meaning |
| --- | --- |
| `SUCCESS` | sync method finished, `data[0]` is the return value |
| `ERROR` | `data[0]` is the error message |
| `ASYNC_SENT` | async method started; answer arrives as `ASYNC_RESPONSE\|<id>\|<code>` |
| `ASYNC_SENT_FAILED` | request id is already in use |

* `"Method"` / `"Method|0"` with `RVExtensionArgs` runs synchronously.
* `"Method|123"` starts an async request; the result comes back as a callback.
* `"Method|-1"` is fire-and-forget.

The DLL never blocks Arma: REST requests are queued and delivered through
`ExtensionCallback`, coalesced into `BATCH` messages when a burst arrives within a frame
(Arma only accepts ~100 callbacks per frame).

Logs: `%LOCALAPPDATA%\SqfReloader\logs\SqfReloader.log`.

## Validation

```powershell
powershell -ExecutionPolicy Bypass -File tools\check-sqf.ps1        # SQF balance + CfgFunctions
powershell -ExecutionPolicy Bypass -File tools\build.ps1            # DLL + mod folder (+ -PackPbo)
powershell -ExecutionPolicy Bypass -File tools\test-extension.ps1   # Arma -> extension, via harness
powershell -ExecutionPolicy Bypass -File tools\smoke-test.ps1       # PE exports, ABI, REST, batching
```

### `tools\test-extension.ps1` - the Arma -> extension direction

EdenOnline tested its DLL with the killzonekid `callExtension` harness: it downloads
`callExtension_v2.0.zip`, puts a `.sqf` script next to the DLL and runs it. `test-extension.ps1`
does the same for SqfReloader, so the SQF -> `callExtension` path can be exercised without the game:

1. installs the harness with [install-call-extension.ps1](tools/install-call-extension.ps1)
   (downloaded once into `tests\callExtension`),
2. publishes `SqfReloader_x64.dll` and copies it next to `callExtension_x64.exe`,
3. runs [tests\callExtension\sqfreloader_test.sqf](tests/callExtension/sqfreloader_test.sqf), which
   calls `Version`, `Ping` (with an argument), an unknown method (error path),
   `ApiStartFromConfig`, `ApiPort` and `Reload` (callback path), then `freeExtension`,
4. asserts the harness output: DLL loaded, callback registered, `SUCCESS`/`ERROR` payloads
   and return codes, `REST API listening ...`, an `ExtensionCallback` for `RELOAD`,
5. while the harness is alive, calls the REST API the script started (`/api/status`,
   `/api/send`) and checks the message reaches the callback.

```powershell
# after changing a C# method or an SQF call:
powershell -ExecutionPolicy Bypass -File tools\test-extension.ps1

# keep the harness running to poke the API by hand:
powershell -ExecutionPolicy Bypass -File tools\test-extension.ps1 -KeepRunning

# test a different script:
powershell -ExecutionPolicy Bypass -File tools\test-extension.ps1 -NoBuild -TestScript my_test.sqf
```

This runs the DLL through the same entry points Arma uses (`RVExtensionVersion`,
`RVExtension`, `RVExtensionArgs`, `RVExtensionRegisterCallback`), so argument binding,
return codes and `ExtensionCallback` delivery are covered by a real harness instead of a
re-implementation. `smoke-test.ps1` remains the faster check for REST and batching.
