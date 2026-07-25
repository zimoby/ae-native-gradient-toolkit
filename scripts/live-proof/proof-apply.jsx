(function () {
    var IMPLEMENTATION = "proof-apply";
    var KEY = "__AE_NATIVE_GRADIENT_LIVE_PROOF_CONFIG__";
    var config = $.global[KEY];
    var result = { success: false, implementation: IMPLEMENTATION, mutationAttempted: false };
    var undoOpened = false;
    var selectionSnapshot = null;

    function fail(message) { throw new Error(message); }
    function projectAndComp() {
        if (config == null || config.phase !== "apply") fail("apply config is unavailable or has wrong phase");
        if (app.project == null || app.project.file == null) fail("no saved project is open");
        if (app.project.file.fsName !== config.projectPath) fail("project path mismatch");
        if (app.project.dirty !== false) fail("apply requires a clean project");
        var comp = app.project.activeItem;
        if ((comp instanceof CompItem) === false) fail("active item is not a composition");
        if (comp.id !== config.target.compId || comp.name !== config.target.compName) fail("active comp identity mismatch");
        return comp;
    }
    function resolveTarget(comp) {
        var layer = comp.layer(config.target.layerIndex);
        if (layer == null || layer.id !== config.target.layerId || layer.name !== config.target.layerName) fail("layer identity mismatch");
        if (layer.locked === true) fail("target layer is locked");
        var current = layer;
        for (var i = 0; i < config.target.propertyIndexPath.length; i += 1) {
            current = current.property(config.target.propertyIndexPath[i]);
            if (current == null || current.matchName !== config.target.matchNamePath[i]) fail("property path drift at index " + i);
        }
        var expectedParent = config.kind === "fill" ? "ADBE Vector Graphic - G-Fill" : "ADBE Vector Graphic - G-Stroke";
        if (current.matchName !== "ADBE Vector Grad Colors" || current.parentProperty == null || current.parentProperty.matchName !== expectedParent) fail("wrong gradient target kind");
        if (current.numKeys !== 0) fail("gradient target is keyed");
        if (current.canSetExpression === true && current.expressionEnabled === true) fail("gradient target has an expression");
        return { layer: layer, property: current };
    }
    function pathFromLayer(property) {
        var path = [];
        var current = property;
        while (current != null && current.propertyIndex != null) {
            path.unshift(current.propertyIndex);
            current = current.parentProperty;
        }
        return path;
    }
    function resolvePath(layer, path) {
        var current = layer;
        for (var i = 0; i < path.length; i += 1) {
            current = current.property(path[i]);
            if (current == null) return null;
        }
        return current;
    }
    function captureSelection(comp) {
        var snapshot = [];
        for (var i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            var propertyPaths = [];
            var selected = layer.selectedProperties;
            for (var j = 0; j < selected.length; j += 1) propertyPaths.push(pathFromLayer(selected[j]));
            snapshot.push({ layerId: layer.id, layerIndex: i, selected: layer.selected, propertyPaths: propertyPaths });
        }
        return snapshot;
    }
    function clearSelection(comp) {
        for (var i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            var selected = layer.selectedProperties;
            for (var j = selected.length - 1; j >= 0; j -= 1) {
                try { selected[j].selected = false; } catch (ignoreProperty) {}
            }
            layer.selected = false;
        }
    }
    function restoreSelection(comp, snapshot) {
        clearSelection(comp);
        for (var i = 0; i < snapshot.length; i += 1) {
            var entry = snapshot[i];
            var layer = comp.layer(entry.layerIndex);
            if (layer == null || layer.id !== entry.layerId) fail("cannot restore selection after layer drift");
            layer.selected = entry.selected;
            for (var j = 0; j < entry.propertyPaths.length; j += 1) {
                var property = resolvePath(layer, entry.propertyPaths[j]);
                if (property == null) fail("cannot restore selected property after drift");
                property.selected = true;
            }
        }
    }

    try {
        var comp = projectAndComp();
        var target = resolveTarget(comp);
        var preset = new File(config.presetPath);
        if (preset.fsName !== config.presetPath || preset.exists !== true) fail("preset path is missing or changed");
        if (preset.length < 1 || preset.length > 8388608) fail("preset size is outside live-proof bounds");
        selectionSnapshot = captureSelection(comp);

        app.beginUndoGroup("AE Native Gradient Proof " + config.runToken);
        undoOpened = true;
        clearSelection(comp);
        target.layer.selected = true;
        target.property.selected = true;
        result.mutationAttempted = true;
        target.layer.applyPreset(preset);
        result.success = true;
        result.projectDirtyAfter = app.project.dirty;
        result.compId = comp.id;
        result.layerId = target.layer.id;
    } catch (error) {
        result.error = error.toString();
        result.line = error.line || null;
    } finally {
        try {
            if (selectionSnapshot != null && app.project != null && app.project.activeItem instanceof CompItem) {
                restoreSelection(app.project.activeItem, selectionSnapshot);
                result.selectionRestored = true;
            }
        } catch (selectionError) {
            result.success = false;
            result.selectionRestored = false;
            result.selectionError = selectionError.toString();
        }
        if (undoOpened) {
            try { app.endUndoGroup(); } catch (undoError) {
                result.success = false;
                result.undoGroupError = undoError.toString();
            }
        }
    }
    return result;
})()
