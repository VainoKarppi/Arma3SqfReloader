/*
    Author: Arma 3 SQF Reloader

    Description:
        preInit example for mission-local CfgFunctions. Runs before the mission
        objects are initialized.

    Parameter(s):
        None

    Returns:
        Nothing

    Example:
        // Executed by Arma through CfgFunctions preInit; no call needed.
*/
if (hasInterface) exitWith {};
diag_log "[ExampleMission] CfgFunctions preInit ran (SP)";
missionNamespace setVariable ["ExampleMission_preInitRan", true];
