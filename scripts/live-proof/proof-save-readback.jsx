(function () {
    var IMPLEMENTATION = "proof-save-readback";
    var KEY = "__AE_NATIVE_GRADIENT_LIVE_PROOF_CONFIG__";
    var config = $.global[KEY];
    var result = { success: false, implementation: IMPLEMENTATION, mutationAttempted: false };

    function fail(message) { throw new Error(message); }
    function findCompByIdentity() {
        var found = null;
        for (var i = 1; i <= app.project.numItems; i += 1) {
            var item = app.project.item(i);
            if (item.id === config.target.compId || item.name === config.target.compName) {
                if ((item instanceof CompItem) === false) fail("expected comp identity resolves to a non-comp item");
                if (item.id !== config.target.compId || item.name !== config.target.compName) fail("partial comp identity collision");
                if (found != null) fail("duplicate expected comp identity");
                found = item;
            }
        }
        return found;
    }
    function resolveTarget(comp) {
        var layer = comp.layer(config.target.layerIndex);
        if (layer == null || layer.id !== config.target.layerId || layer.name !== config.target.layerName) fail("layer identity mismatch");
        var current = layer;
        for (var i = 0; i < config.target.propertyIndexPath.length; i += 1) {
            current = current.property(config.target.propertyIndexPath[i]);
            if (current == null || current.matchName !== config.target.matchNamePath[i]) fail("property path drift at index " + i);
        }
        return { layer: layer, property: current };
    }
    function assertTargetAbsent(comp) {
        if (config.target.compCreatedByHarness) {
            if (comp != null) fail("harness-created comp still exists after cleanup");
            return;
        }
        if (comp == null) fail("reusable proof comp is missing after cleanup");
        for (var i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            if (layer.id === config.target.layerId || layer.name === config.target.layerName) {
                fail("token-owned target layer still exists after cleanup");
            }
        }
    }
    function pathFromLayer(property) {
        var path = [];
        var matches = [];
        var current = property;
        while (current != null && current.propertyIndex != null) {
            path.unshift(current.propertyIndex);
            matches.unshift(current.matchName);
            current = current.parentProperty;
        }
        return { indices: path, matchNames: matches };
    }
    function safeValue(property) {
        try {
            if (property.numKeys > 0) return { keyed: true, numKeys: property.numKeys };
            var value = property.value;
            if (value instanceof Array) return { value: value.slice(0) };
            if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return { value: value };
            return { valueType: typeof value };
        } catch (error) {
            return { unavailable: true, error: error.toString() };
        }
    }
    function parentSnapshot(target) {
        var parent = target.property.parentProperty;
        var children = [];
        for (var i = 1; i <= parent.numProperties; i += 1) {
            var child = parent.property(i);
            children.push({ index: i, name: child.name, matchName: child.matchName, state: safeValue(child) });
        }
        return { parentMatchName: parent.matchName, children: children };
    }
    function selectionSnapshot(comp) {
        if (comp == null) return [];
        var layers = [];
        for (var i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            var properties = [];
            var selected = layer.selectedProperties;
            for (var j = 0; j < selected.length; j += 1) properties.push(pathFromLayer(selected[j]));
            layers.push({ id: layer.id, index: i, name: layer.name, selected: layer.selected, selectedProperties: properties });
        }
        return layers;
    }
    function itemSnapshot() {
        var items = [];
        for (var i = 1; i <= app.project.numItems; i += 1) {
            var item = app.project.item(i);
            items.push({ id: item.id, index: i, name: item.name, typeName: item.typeName });
        }
        return items;
    }
    function projectSnapshot(comp) {
        var active = app.project.activeItem;
        return {
            projectPath: app.project.file == null ? null : app.project.file.fsName,
            projectDirty: app.project.dirty,
            itemCount: app.project.numItems,
            items: itemSnapshot(),
            activeItem: active == null ? null : { id: active.id, name: active.name, typeName: active.typeName },
            comp: comp == null ? null : { id: comp.id, name: comp.name, layerCount: comp.numLayers },
            selection: selectionSnapshot(comp)
        };
    }
    function capturePresent(comp, target) {
        var snapshot = projectSnapshot(comp);
        snapshot.targetPresent = true;
        snapshot.targetPath = pathFromLayer(target.property);
        snapshot.targetParent = parentSnapshot(target);
        return snapshot;
    }
    function captureAbsent(comp) {
        var snapshot = projectSnapshot(comp);
        snapshot.targetPresent = false;
        return snapshot;
    }

    try {
        if (config == null || config.phase !== "save-readback") fail("save-readback config is unavailable or has wrong phase");
        if (app.project == null || app.project.file == null) fail("no saved project is open");
        if (app.project.file.fsName !== config.projectPath) fail("project path mismatch");
        var comp = findCompByIdentity();
        var target = null;
        if (config.expectedTargetPresent) {
            if (comp == null) fail("expected comp is missing");
            if (app.project.activeItem !== comp) fail("active comp identity mismatch");
            target = resolveTarget(comp);
            result.before = capturePresent(comp, target);
        } else {
            assertTargetAbsent(comp);
            result.before = captureAbsent(comp);
        }
        result.mutationAttempted = true;
        app.project.save();
        if (app.project.file == null || app.project.file.fsName !== config.projectPath) fail("save changed project identity");
        if (app.project.dirty !== false) fail("project remained dirty after save");
        if (config.expectedTargetPresent) {
            result.after = capturePresent(comp, target);
        } else {
            comp = findCompByIdentity();
            assertTargetAbsent(comp);
            result.after = captureAbsent(comp);
        }
        result.success = true;
    } catch (error) {
        result.error = error.toString();
        result.line = error.line || null;
    }
    return result;
})()
