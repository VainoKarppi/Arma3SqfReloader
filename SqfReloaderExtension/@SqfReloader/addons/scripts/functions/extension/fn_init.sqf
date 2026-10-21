// SqfReloader_fnc_init
// Loads the extension into memory and registers the ExtensionCallback handler.
// Safe to call repeatedly; returns true once the DLL answered.

if (SqfReloader_var_ready) exitWith {true};

SqfReloader_var_extension = "SqfReloader";
SqfReloader_var_ready = false;
SqfReloader_var_asyncRequests = createHashMap;     // requestId -> function name
SqfReloader_var_asyncResponses = createHashMap;    // requestId -> [data, returnCode]
SqfReloader_var_lastError = "";
SqfReloader_var_apiRunning = false;

if (isNil "SqfReloader_var_debug") then {SqfReloader_var_debug = false};

// The first callExtension on a fresh DLL returns "" until it has been loaded.
private _answer = SqfReloader_var_extension callExtension ["Version", []];
if (_answer isEqualTo "") then {
    // Second call forces the load.
    _answer = SqfReloader_var_extension callExtension ["Version", []];
};

if (_answer isEqualTo "") exitWith {
    SqfReloader_var_lastError = "SqfReloader_x64.dll not found. Copy it next to arma3_x64.exe (the installer does this) or add -mod to the game.";
    diag_log format ["[SqfReloader] ERROR: %1", SqfReloader_var_lastError];
    false
};

// callExtension returns an ARRAY (one entry per RVExtensionArgs return value). A missing
// extension returns an empty string instead, and parseSimpleArray on that raises
// "Error parseSimpleArray format error" instead of reporting the real problem.
private _payload = if (_answer isEqualType "") then {_answer} else {_answer param [0, ""]};
if (_payload isEqualTo "") exitWith {
    SqfReloader_var_lastError = "Extension 'SqfReloader' answered nothing. Is SqfReloader_x64.dll in @SqfReloader or next to arma3_x64.exe?";
    diag_log format ["[SqfReloader] ERROR: %1", SqfReloader_var_lastError];
    false
};

private _result = parseSimpleArray _payload;
if !(_result isEqualType []) exitWith {
    SqfReloader_var_lastError = "Extension answered with an unreadable payload: " + _payload;
    diag_log format ["[SqfReloader] ERROR: %1", SqfReloader_var_lastError];
    false
};

_result params ["_code", ["_data", []]];

if (_code != "SUCCESS") exitWith {
    SqfReloader_var_lastError = str _data;
    diag_log format ["[SqfReloader] ERROR: %1", _data];
    false
};

SqfReloader_var_version = _data param [0, "unknown"];

// Extension callbacks arrive through addMissionEventHandler "ExtensionCallback".
if (isNil "SqfReloader_var_callbackRegistered") then {
    addMissionEventHandler ["ExtensionCallback", {
        params ["_name", "_function", "_data"];

        if (_name != "SqfReloader") exitWith {};

        [_function, _data] call SqfReloader_fnc_handleCallback;
    }];

    SqfReloader_var_callbackRegistered = true;
};

SqfReloader_var_ready = true;

diag_log format ["[SqfReloader] extension loaded, version %1", SqfReloader_var_version];

true
