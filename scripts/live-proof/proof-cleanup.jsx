(function () {
    var IMPLEMENTATION = "proof-cleanup";
    var KEY = "__AE_NATIVE_GRADIENT_LIVE_PROOF_CONFIG__";
    var config = $.global[KEY];
    var result = { success: false, implementation: IMPLEMENTATION, mutationAttempted: false };
    var undoOpened = false;

    function fail(message) { throw new Error(message); }
    try {
        if (config == null || config.phase !== "cleanup") fail("cleanup config is unavailable or has wrong phase");
        if (app.project == null || app.project.file == null) fail("no saved project is open");
        if (app.project.file.fsName !== config.projectPath) fail("project path mismatch");
        if (app.project.dirty !== false) fail("cleanup requires a clean project after accepted evidence");
        var comp = app.project.activeItem;
        if ((comp instanceof CompItem) === false) fail("active item is not a composition");
        if (comp.id !== config.target.compId || comp.name !== config.target.compName) fail("active comp identity mismatch");
        var layer = comp.layer(config.target.layerIndex);
        if (layer == null || layer.id !== config.target.layerId || layer.name !== config.target.layerName) fail("token-owned cleanup layer identity mismatch");
        if (layer.name !== "__AE_NG_" + config.runToken + "_" + config.kind + "__") fail("cleanup marker mismatch");

        if (config.target.compCreatedByHarness && comp.numLayers !== 1) {
            fail("refusing to remove harness-created comp because it contains unexpected layers");
        }

        app.beginUndoGroup("AE Native Gradient Proof Cleanup " + config.runToken);
        undoOpened = true;
        result.mutationAttempted = true;
        if (config.target.compCreatedByHarness) {
            comp.remove();
            result.removedComp = true;
            result.remainingLayers = null;
        } else {
            layer.remove();
            result.removedComp = false;
            result.remainingLayers = comp.numLayers;
        }
        result.success = true;
        result.compId = config.target.compId;
    } catch (error) {
        result.error = error.toString();
        result.line = error.line || null;
    } finally {
        if (undoOpened) {
            try { app.endUndoGroup(); } catch (undoError) {
                result.success = false;
                result.undoGroupError = undoError.toString();
            }
        }
    }
    return result;
})()
