class CfgPatches {
    class example {
        units[] = {};
        weapons[] = {};
        requiredVersion = 2.02;
        requiredAddons[] = {"A3_Functions_F"};
        author = "Arma 3 SQF Reloader";
        version = "1.0.0";
        versionStr = "1.0.0";
        versionAr[] = {1, 0, 0};

    };
};

class CfgFunctions {
    class example {
        tag = "example";

        class Core {
            file = "\example\functions";

            class hello {};
            class add {};
            class showCounter {};
        };
    };
};

class Cfg3DEN {
    class EventHandlers {
        class example {
            init = "diag_log 'SQFR: 3DEN init';";
        };
    };
};
