// This runs in the playable mission's namespace, after the Eden-to-mission handoff.
// Re-run startup here so addon prefix metadata is initialized in this namespace too.
diag_log format ["[SqfReloader] mission postInit: entering (is3DEN=%1, missionConfig=%2)", is3DEN, str missionConfigFile];
[] call SqfReloader_fnc_runStartup;

[] spawn {
    uiSleep 0.5;
    private _registered = [] call SqfReloader_fnc_reloadFunctions;
    diag_log format ["[SqfReloader] postInit: registered %1 custom CfgFunctions; example_fnc_add isNil=%2", _registered, isNil {missionNamespace getVariable "example_fnc_add"}];

    // Some mission initialization code replaces values after postInit. One final scan
    // after startup settles makes the functions available to the live mission.
    uiSleep 1;
    _registered = [] call SqfReloader_fnc_reloadFunctions;
    diag_log format ["[SqfReloader] mission startup refresh: registered %1 custom CfgFunctions; example_fnc_add isNil=%2", _registered, isNil {missionNamespace getVariable "example_fnc_add"}];
};
