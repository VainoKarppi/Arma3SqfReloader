// ArmaApi_fnc_addEditorMenu
// Idempotent: adds the "Arma API" entries to the Eden Editor Tools menu.

if !(is3DEN) exitWith {false};

if (missionNamespace getVariable ["ArmaApi_var_menuAdded", false]) exitWith {true};
missionNamespace setVariable ["ArmaApi_var_menuAdded", true];

true
