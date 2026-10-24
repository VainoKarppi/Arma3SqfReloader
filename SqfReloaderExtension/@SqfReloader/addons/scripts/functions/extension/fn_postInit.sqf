// This runs in the playable mission's namespace, after the Eden-to-mission handoff.
// Re-run startup here so addon prefix metadata is initialized in this namespace too.
[] call SqfReloader_fnc_runStartup;

[] spawn {
    uiSleep 0.5;
    if (!is3DEN) then {
        [] call SqfReloader_fnc_runStartup;
    };
};
