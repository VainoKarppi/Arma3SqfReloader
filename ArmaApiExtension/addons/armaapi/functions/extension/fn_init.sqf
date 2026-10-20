// ArmaApi_fnc_init
// Loads the extension into memory and registers the ExtensionCallback handler.
// Safe to call repeatedly; returns true once the DLL answered.

if (ArmaApi_var_ready) exitWith {true};

ArmaApi_var_extension = "ArmaApi";
ArmaApi_var_ready = false;
ArmaApi_var_asyncRequests = createHashMap;     // requestId -> function name
ArmaApi_var_asyncResponses = createHashMap;    // requestId -> [data, returnCode]
ArmaApi_var_lastError = "";
ArmaApi_var_apiRunning = false;

if (isNil "ArmaApi_var_debug") then {ArmaApi_var_debug = false};

// The first callExtension on a fresh DLL returns "" until it has been loaded.
private _answer = ArmaApi_var_extension callExtension ["Version", []];
if (_answer isEqualTo "") then {
    // Second call forces the load.
    _answer = ArmaApi_var_extension callExtension ["Version", []];
};

if (_answer isEqualTo "") exitWith {
    ArmaApi_var_lastError = "ArmaApi_x64.dll not found. Copy it next to arma3_x64.exe (the installer does this) or add -mod to the game.";
    diag_log format ["[ArmaApi] ERROR: %1", ArmaApi_var_lastError];
    false
};

private _result = parseSimpleArray (_answer select 0);
_result params ["_code", ["_data", []]];

if (_code != "SUCCESS") exitWith {
    ArmaApi_var_lastError = str _data;
    diag_log format ["[ArmaApi] ERROR: %1", _data];
    false
};

ArmaApi_var_version = _data param [0, "unknown"];

// Extension callbacks arrive through addMissionEventHandler "ExtensionCallback".
if (isNil "ArmaApi_var_callbackRegistered") then {
    addMissionEventHandler ["ExtensionCallback", {
        params ["_name", "_function", "_data"];

        if (_name != "ArmaApi") exitWith {};

        [_function, _data] call ArmaApi_fnc_handleCallback;
    }];

    ArmaApi_var_callbackRegistered = true;
};

ArmaApi_var_ready = true;

diag_log format ["[ArmaApi] extension loaded, version %1", ArmaApi_var_version];

true
