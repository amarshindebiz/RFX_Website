"""
RFX_MayaViewer - Maya WebSocket server plugin
Streams scene geometry, lights, and camera to the iOS viewer app.

Usage in Maya Script Editor:
    import rfx_mayaviewer as mv
    mv.start_server()          # start on default port 9001
    mv.stop_server()           # stop
    mv.send_snapshot()         # push current scene manually
"""

import sys
import os
import json
import math
import struct
import threading
import socket
import time
import base64
import hashlib
import re
import zlib
import xml.etree.ElementTree as ET

import maya.cmds as cmds
import maya.api.OpenMaya as om
import maya.utils

# Python built-in websocket server (no pip install needed for basic TCP)
# We implement a minimal RFC 6455 WebSocket server by hand to avoid
# external dependencies inside Maya.

_SERVER_THREAD  = None
_SERVER_SOCKET  = None
_SERVER_STOP_EVENT = threading.Event()
_CLIENTS        = []          # list of connected client sockets
_CLIENTS_LOCK   = threading.Lock()
_LIVE_SYNC      = False
_SELECTED_ONLY  = False       # if True, only stream selected objects
_CALLBACK_IDS   = []
_PORT           = 9001
_PROTOCOL_VERSION = 2
_SENT_TEXTURE_HASHES = set()  # tracks textures broadcast this server session
_MAX_TEXTURE_BYTES   = 32 * 1024 * 1024  # skip textures larger than 32 MB
_TARGET_TEXTURE_BYTES = 8 * 1024 * 1024   # preserve more source texture detail before resizing
_MAX_TEXTURE_DIMENSION = 4096
_WS_TEXT_CHUNK_SIZE = 512 * 1024
_CHUNK_SEQ = 0
_TRANSFORM_UNDO_STACK = []
_TRANSFORM_REDO_STACK = []
_TRANSFORM_HISTORY_LIMIT = 50
_SUPPRESS_SCENE_CALLBACK_UNTIL = 0.0
_LIVE_SYNC_PENDING = False
_CONNECTION_PIN = ""          # optional shared secret; empty = no auth

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def start_server(port=9001, pin=""):
    global _SERVER_THREAD, _SERVER_SOCKET, _PORT, _CONNECTION_PIN
    _PORT = port
    _CONNECTION_PIN = str(pin).strip()

    if _SERVER_THREAD and _SERVER_THREAD.is_alive():
        print("[RFX_MayaViewer] Server already running on port %d" % _PORT)
        return

    _SERVER_STOP_EVENT.clear()
    _SERVER_SOCKET = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    _SERVER_SOCKET.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    _SERVER_SOCKET.bind(("0.0.0.0", _PORT))
    _SERVER_SOCKET.listen(5)
    _SERVER_SOCKET.settimeout(1.0)

    _SERVER_THREAD = threading.Thread(target=_accept_loop, daemon=True)
    _SERVER_THREAD.start()

    local_ips = _get_local_ips()
    print("[RFX_MayaViewer] Server started.")
    print("[RFX_MayaViewer] Enter one of these COMPUTER IP addresses in the iOS app:")
    for index, ip in enumerate(local_ips):
        label = "recommended" if index == 0 else "alternate"
        print("[RFX_MayaViewer]   Computer IP (%s): %s   Port: %d" % (label, ip, _PORT))
    if _CONNECTION_PIN:
        print("[RFX_MayaViewer]   PIN: %s" % _CONNECTION_PIN)


def stop_server():
    global _SERVER_SOCKET, _SERVER_THREAD, _LIVE_SYNC
    _SERVER_STOP_EVENT.set()
    _LIVE_SYNC = False
    _unregister_callbacks()

    server_socket = _SERVER_SOCKET
    _SERVER_SOCKET = None
    if server_socket:
        try:
            server_socket.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            server_socket.close()
        except Exception:
            pass

    with _CLIENTS_LOCK:
        clients = list(_CLIENTS)
        _CLIENTS[:] = []
    for client in clients:
        try:
            client.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            client.close()
        except Exception:
            pass

    if _SERVER_THREAD and _SERVER_THREAD.is_alive():
        try:
            _SERVER_THREAD.join(timeout=1.5)
        except Exception:
            pass
    _SERVER_THREAD = None
    print("[RFX_MayaViewer] Server stopped.")


def send_snapshot(extra=None):
    """Serialize the current scene and push to all connected clients."""
    if _SERVER_STOP_EVENT.is_set():
        return
    payload = _build_scene_payload(extra=extra)
    if payload is None:
        return
    data = json.dumps(payload)
    _broadcast_scene_json(data)
    _broadcast_new_textures(payload)
    print("[RFX_MayaViewer] Snapshot sent (%d bytes, %d mesh(es))" % (
        len(data), len(payload.get("meshes", []))))


def set_live_sync(enabled):
    global _LIVE_SYNC
    if enabled and _SERVER_STOP_EVENT.is_set():
        return
    _LIVE_SYNC = enabled
    if enabled:
        _register_callbacks()
        print("[RFX_MayaViewer] Live sync ON")
    else:
        _unregister_callbacks()
        print("[RFX_MayaViewer] Live sync OFF")


def set_selected_only(enabled):
    """Stream only selected objects instead of all visible meshes."""
    global _SELECTED_ONLY
    _SELECTED_ONLY = enabled
    print("[RFX_MayaViewer] Selected only: %s" % ("ON" if enabled else "OFF"))


# ---------------------------------------------------------------------------
# Scene serialization
# ---------------------------------------------------------------------------

def _build_scene_payload(extra=None):
    meshes  = _collect_meshes()
    lights  = _collect_lights()
    camera  = _collect_active_camera()
    cameras = _collect_user_cameras()
    payload = {
        "type":    "scene_update",
        "meshes":  meshes,
        "lights":  lights,
        "camera":  camera,
        "cameras": cameras,
        "stats":   _collect_scene_stats(meshes)
    }
    if extra:
        payload.update(extra)
    return payload


def _collect_scene_stats(meshes):
    """Return Maya-authored scene stats for the same mesh set we stream.

    The app should display the same kind of totals Maya artists see in the
    viewport HUD. MFnMesh counts can differ from Maya's display evaluation
    when smooth-preview/display evaluation is active, so prefer polyEvaluate.
    """
    transforms = []
    for mesh in meshes or []:
        name = mesh.get("full_path") or mesh.get("name")
        if name:
            transforms.append(name)

    def eval_flag(flag, fallback_key):
        try:
            if transforms:
                value = cmds.polyEvaluate(*transforms, **{flag: True})
            else:
                value = cmds.polyEvaluate(**{flag: True})
            if isinstance(value, dict):
                value = next(iter(value.values()), 0)
            return int(value or 0)
        except Exception as e:
            print("[RFX_MayaViewer] polyEvaluate %s failed, using payload fallback: %s" % (
                flag, str(e)))
            total = 0
            for mesh in meshes or []:
                total += int(mesh.get(fallback_key, 0) or 0)
            return total

    stats = {
        "mesh_count":   len(meshes or []),
        "vertex_count": eval_flag("vertex",   "vertex_count"),
        "tri_count":    eval_flag("triangle", "tri_count"),
        "poly_count":   eval_flag("face",     "poly_count"),
    }
    print("[RFX_MayaViewer] Scene stats: %d mesh(es), %d verts, %d tris, %d polys" % (
        stats["mesh_count"], stats["vertex_count"], stats["tri_count"], stats["poly_count"]))
    return stats


def _collect_meshes():
    if _SELECTED_ONLY:
        return _collect_selected_meshes()

    result = []
    mesh_transforms = cmds.ls(type="mesh", long=True) or []

    for shape in mesh_transforms:
        # Get transform
        parents = cmds.listRelatives(shape, parent=True, fullPath=True)
        if not parents:
            continue
        transform = parents[0]

        if not _is_shape_streamable(shape, transform):
            continue

        mesh_data = _extract_mesh_data(shape, transform)
        if mesh_data:
            result.append(mesh_data)

    return result


def _is_transform_visible(transform):
    """True only if the transform and every ancestor are visible and not
    inside a hidden display layer.  Walks the full DAG hierarchy."""
    current = transform
    while current:
        try:
            if not cmds.getAttr(current + ".visibility"):
                return False
        except Exception:
            pass

        for layer in (cmds.listConnections(current, type="displayLayer") or []):
            try:
                if not cmds.getAttr(layer + ".visibility"):
                    return False
            except Exception:
                pass

        parents = cmds.listRelatives(current, parent=True, fullPath=True)
        current = parents[0] if parents else None

    return True


def _is_shape_streamable(shape, transform):
    """True when a mesh should be streamed in all-object mode."""
    if not _is_transform_visible(transform):
        return False
    try:
        if cmds.getAttr(shape + ".intermediateObject"):
            return False
    except Exception:
        pass
    try:
        if not cmds.getAttr(shape + ".visibility"):
            return False
    except Exception:
        pass
    for layer in (cmds.listConnections(shape, type="displayLayer") or []):
        try:
            if not cmds.getAttr(layer + ".visibility"):
                return False
        except Exception:
            pass
    return True


def _collect_selected_meshes():
    """Return mesh data for the current selection.

    Handles three selection types Maya produces:
      - Transform nodes  (ordinary object selection)
      - Mesh shape nodes (direct shape selection via outliner or API)
      - Component tokens (e.g. pCube1.f[0:5]) — resolved back to the mesh

    Visibility is checked all the way up the DAG and through display layers.
    Duplicate shapes are de-duplicated so each mesh appears only once.
    """
    result = []
    seen_shapes = set()

    # No type filter — captures transforms, shapes, and component tokens.
    raw = cmds.ls(selection=True, long=True) or []

    for item in raw:
        # Component selections arrive as "nodePath.componentType[range]".
        # Strip the component suffix to recover the owning node path.
        node_path = item.split(".")[0] if "." in item.split("|")[-1] else item

        if not cmds.objExists(node_path):
            continue

        node_type = cmds.nodeType(node_path)

        if node_type == "mesh":
            shape = node_path
            parents = cmds.listRelatives(shape, parent=True, fullPath=True)
            if not parents:
                continue
            transform = parents[0]

        elif node_type == "transform":
            transform = node_path
            shapes_under = cmds.listRelatives(
                transform, shapes=True, fullPath=True, type="mesh"
            ) or []
            if not shapes_under:
                continue
            shape = shapes_under[0]

        else:
            continue

        if shape in seen_shapes:
            continue
        seen_shapes.add(shape)

        if not _is_shape_streamable(shape, transform):
            continue

        mesh_data = _extract_mesh_data(shape, transform)
        if mesh_data:
            result.append(mesh_data)

    return result


def _extract_mesh_data(shape, transform):
    try:
        sel = om.MSelectionList()
        sel.add(shape)
        dag_path = sel.getDagPath(0)
        mesh_fn = om.MFnMesh(dag_path)

        tri_counts, tri_indices = mesh_fn.getTriangles()
        raw_points = mesh_fn.getPoints(om.MSpace.kWorld)

        try:
            vtx_normals = mesh_fn.getVertexNormals(False, om.MSpace.kWorld)
        except Exception:
            vtx_normals = None

        # UV set
        uv_set = None
        u_vals = []
        v_vals = []
        try:
            uv_sets = mesh_fn.getUVSetNames()
            if uv_sets:
                uv_set = uv_sets[0]
                u_vals, v_vals = mesh_fn.getUVs(uv_set)
        except Exception:
            pass

        # Face → local vertex index map (needed for UV lookups)
        face_local_map = []
        for face_id in range(mesh_fn.numPolygons):
            fv = mesh_fn.getPolygonVertices(face_id)
            face_local_map.append({int(v): i for i, v in enumerate(fv)})

        # Per-face material assignments
        shaders = []
        face_shader_indices = []
        try:
            shaders, face_shader_arr = mesh_fn.getConnectedShaders(0)
            face_shader_indices = list(face_shader_arr)
        except Exception:
            pass
        if not face_shader_indices:
            face_shader_indices = [0] * mesh_fn.numPolygons

        shader_materials = []
        for sg_obj in shaders:
            try:
                sg_name = om.MFnDependencyNode(sg_obj).name()
                shader_materials.append(_get_material_from_sg(
                    sg_name,
                    context_name=transform.split("|")[-1]
                ))
            except Exception:
                shader_materials.append(_fallback_material())
        if not shader_materials:
            shader_materials = [_get_mesh_material(shape, transform.split("|")[-1])]

        # UV seam splitting: key = (orig_vertex_id, uv_id) → new_vertex_index
        key_to_new = {}
        orig_to_first_new = {}
        new_verts = []
        new_norms = []
        new_uvs = [] if uv_set else None
        new_indices = []
        face_tri_mat = []

        tri_offset = 0
        for face_id in range(mesh_fn.numPolygons):
            num_tris = int(tri_counts[face_id])
            local_map = face_local_map[face_id]
            mat_idx = face_shader_indices[face_id] if face_id < len(face_shader_indices) else 0

            for t in range(num_tris):
                face_tri_mat.append(mat_idx)
                for c in range(3):
                    abs_vid = int(tri_indices[tri_offset + t * 3 + c])
                    local_vid = local_map.get(abs_vid, 0)

                    uv_id = -1
                    if uv_set:
                        try:
                            uv_id = int(mesh_fn.getPolygonUVid(face_id, local_vid, uv_set))
                        except Exception:
                            pass

                    key = (abs_vid, uv_id)
                    if key not in key_to_new:
                        new_idx = len(new_verts) // 3
                        key_to_new[key] = new_idx
                        if abs_vid not in orig_to_first_new:
                            orig_to_first_new[abs_vid] = new_idx
                        pt = raw_points[abs_vid]
                        new_verts.extend([round(pt.x, 5), round(pt.y, 5), round(pt.z, 5)])
                        if vtx_normals:
                            n = vtx_normals[abs_vid]
                            new_norms.extend([round(n.x, 5), round(n.y, 5), round(n.z, 5)])
                        else:
                            new_norms.extend([0.0, 1.0, 0.0])
                        if new_uvs is not None:
                            if 0 <= uv_id < len(u_vals):
                                new_uvs.extend([round(float(u_vals[uv_id]), 5),
                                                round(float(v_vals[uv_id]), 5)])
                            else:
                                new_uvs.extend([0.0, 0.0])

                    new_indices.append(key_to_new[key])
            tri_offset += num_tris * 3

        # Re-order triangles contiguous by material, build face_groups list
        groups_by_mat = {}
        for tri_idx, mat_idx in enumerate(face_tri_mat):
            groups_by_mat.setdefault(mat_idx, []).append(tri_idx)

        reordered = []
        face_groups = []
        for mat_idx in sorted(groups_by_mat.keys()):
            tris = groups_by_mat[mat_idx]
            tri_start = len(reordered) // 3
            for t in tris:
                reordered.extend(new_indices[t * 3: t * 3 + 3])
            mat = shader_materials[mat_idx] if mat_idx < len(shader_materials) else shader_materials[0]
            face_groups.append({"material": mat, "tri_start": tri_start, "tri_count": len(tris)})

        # Polygon edges remapped to new vertex indices (for wireframe overlay)
        try:
            edge_set = set()
            for face_id in range(mesh_fn.numPolygons):
                verts = mesh_fn.getPolygonVertices(face_id)
                n_v = len(verts)
                for i in range(n_v):
                    v0 = orig_to_first_new.get(int(verts[i]),        int(verts[i]))
                    v1 = orig_to_first_new.get(int(verts[(i+1)%n_v]), int(verts[(i+1)%n_v]))
                    edge_set.add((min(v0, v1), max(v0, v1)))
            edges = []
            for v0, v1 in sorted(edge_set):
                edges.extend([v0, v1])
        except Exception:
            edges = []

        first_mat = face_groups[0]["material"] if face_groups else shader_materials[0]
        color = first_mat.get("diffuse_color", [0.7, 0.7, 0.7])
        try:
            pivot = cmds.xform(transform, query=True, worldSpace=True, rotatePivot=True)
        except Exception:
            pivot = [0.0, 0.0, 0.0]
        try:
            tex = first_mat.get("diffuse_texture") if first_mat else None
            if tex and tex.get("path"):
                print("[RFX_MayaViewer] Mesh %s uses texture: %s" % (transform.split("|")[-1], tex.get("path")))
            else:
                print("[RFX_MayaViewer] Mesh %s has no diffuse texture (material %s)" % (
                    transform.split("|")[-1], first_mat.get("name", "unknown")))
        except Exception:
            pass

        return {
            "name":         transform.split("|")[-1],
            "full_path":    transform,
            "pivot":        [round(float(p), 5) for p in pivot[:3]],
            "vertices":     new_verts,
            "normals":      new_norms,
            "indices":      reordered,
            "edges":        edges,
            "color":        color,
            "uvs":          new_uvs,
            "material":     first_mat,
            "face_groups":  face_groups if len(face_groups) > 1 else None,
            "visible":      True,
            "vertex_count": mesh_fn.numVertices,
            "tri_count":    len(reordered) // 3,
            "poly_count":   mesh_fn.numPolygons,
        }

    except Exception as e:
        print("[RFX_MayaViewer] Skipping %s: %s" % (shape, str(e)))
        return None


def _fallback_material():
    return {"name": "default", "type": "default",
            "diffuse_color": [0.7, 0.7, 0.7], "diffuse_texture": None,
            "diffuse_color_connected": False,
            "is_glass": False}


def _get_material_from_sg(sg_name, context_name=None):
    """Return material metadata dict from a shading engine name."""
    try:
        materials = cmds.listConnections(sg_name + ".surfaceShader") or []
        if not materials:
            return _fallback_material()
        mat = materials[0]
        node_type = cmds.nodeType(mat)
        color_attr = None
        color = [0.7, 0.7, 0.7]
        if node_type in ("lambert", "blinn", "phong", "phongE"):
            color_attr = _first_existing_attr(mat, ["color"])
        elif node_type == "aiStandardSurface":
            color_attr = _first_existing_attr(mat, [
                "baseColor",      # common MtoA builds
                "base_color",     # Arnold/translated plug name seen in .mb strings
                "color",
                "diffuseColor"
            ])
        elif node_type in ("standardSurface", "openPBRSurface"):
            # Maya native standardSurface and openPBRSurface both use baseColor.
            color_attr = _first_existing_attr(mat, ["baseColor", "base_color", "color"])
        elif node_type == "aiLambert":
            color_attr = _first_existing_attr(mat, ["KdColor", "color"])
        elif node_type == "aiFlat":
            color_attr = _first_existing_attr(mat, ["color"])
        if color_attr:
            try:
                c = cmds.getAttr(color_attr)[0]
                color = _rendering_color_to_display_rgb(c)
            except Exception:
                pass
        if color_attr:
            color_connected = False
            try:
                color_connected = bool(cmds.listConnections(color_attr, source=True) or [])
            except Exception:
                color_connected = False
            if color_connected:
                texture = _find_file_texture(color_attr, sg_name=sg_name, context_name=context_name)
            else:
                # If the material has an editable base/diffuse color and that plug is
                # not connected, trust the authored color. Do not scan unrelated
                # roughness/spec/utility history as a diffuse texture; openPBR cap
                # materials commonly have non-base networks that otherwise make the
                # app ignore a changed base color and render the cap black.
                texture = None
        else:
            color_connected = False
            texture = _find_material_texture(
                mat,
                sg_name,
                context_name=context_name,
                allow_scene_scan=_is_materialx_shader_node(mat)
            )

        exact_stack_texture = _find_materialx_stack_texture(context_name, exact_only=True)
        if texture is None and exact_stack_texture:
            texture = exact_stack_texture
        if texture and color_attr and color_connected:
            _attach_texture_matte(texture, color)
        return {
            "name":            mat.split("|")[-1],
            "type":            node_type,
            "diffuse_color":   color,
            "diffuse_texture": texture,
            "diffuse_color_connected": color_connected,
            "is_glass":        _is_glass_material(mat, sg_name, context_name)
        }
    except Exception:
        return _fallback_material()


def _rendering_color_to_display_rgb(color):
    """Convert Maya Rendering Space color values to display/sRGB for mobile."""
    result = []
    for channel in (color or [0.7, 0.7, 0.7])[:3]:
        try:
            value = max(0.0, min(1.0, float(channel)))
        except Exception:
            value = 0.7
        if value <= 0.0031308:
            display = value * 12.92
        else:
            display = 1.055 * (value ** (1.0 / 2.4)) - 0.055
        result.append(round(max(0.0, min(1.0, display)), 4))
    while len(result) < 3:
        result.append(0.7)
    return result


def _get_mesh_material(shape, context_name=None):
    """Return material metadata for the first shader connected to shape."""
    try:
        sgs = cmds.listConnections(shape, type="shadingEngine") or []
        if sgs:
            return _get_material_from_sg(sgs[0], context_name=context_name)
    except Exception:
        pass
    return _fallback_material()


def _first_existing_attr(node, attr_names):
    """Return the first plug that exists on node from attr_names."""
    for attr in attr_names:
        plug = node + "." + attr
        try:
            if cmds.objExists(plug):
                return plug
        except Exception:
            pass
    return None


def _find_file_texture(color_attr, sg_name=None, context_name=None):
    """Lookup a file texture node feeding color_attr.

    Supports Maya file, Arnold aiImage, and MaterialX tiledimage/image nodes.
    The path attribute differs per renderer/node family.
    """
    if not color_attr:
        return None
    try:
        texture_node = _find_upstream_texture_node(color_attr)
        if texture_node:
            tex_path = _get_texture_node_path(texture_node)
            if tex_path:
                better = None
                if _texture_node_priority_from_path(tex_path) > 0:
                    better = _find_material_texture(
                        color_attr.split(".")[0],
                        sg_name=sg_name,
                        context_name=context_name,
                        allow_scene_scan=False,
                        skip_nodes={texture_node}
                    )
                if better:
                    print("[RFX_MayaViewer] Replaced non-base texture candidate %s with %s" % (
                        tex_path, better.get("path")))
                    return better
                print("[RFX_MayaViewer] Found texture (%s): %s" % (
                    cmds.nodeType(texture_node), tex_path))
                return {"node": texture_node, "path": tex_path,
                        "hash": _texture_hash(tex_path)}

        embedded = _find_materialx_stack_texture(context_name or sg_name or color_attr.split(".")[0])
        if embedded:
            return embedded

        return _find_material_texture(
            color_attr.split(".")[0],
            sg_name=sg_name,
            context_name=context_name,
            allow_scene_scan=False
        )
    except Exception as e:
        print("[RFX_MayaViewer] _find_file_texture error: %s" % str(e))
        return None


def _is_glass_material(mat_node=None, sg_name=None, context_name=None):
    """Best-effort glass hint for iOS when MaterialX is too complex to render fully."""
    haystack = " ".join([str(v or "") for v in (mat_node, sg_name, context_name)]).lower()
    # Paper/sticker labels are never glass regardless of surrounding name context.
    if "label" in haystack and "cap" not in haystack:
        return False
    # Only the shader node name triggers glass by keyword — mesh names like "bottle"
    # or "cap" are shapes, not material types. Only an explicit "glass" shader name applies.
    mat_name = str(mat_node or "").lower()
    if "glass" in mat_name:
        return True

    for attr in ("transmission", "specularTransmission", "transmissionWeight", "opacity"):
        try:
            plug = mat_node + "." + attr
            if cmds.objExists(plug):
                value = cmds.getAttr(plug)
                if isinstance(value, (list, tuple)):
                    value = value[0]
                if isinstance(value, (list, tuple)):
                    value = max(float(v) for v in value)
                if attr == "opacity":
                    # Opacity is 1.0=fully opaque. Flag as glass only if
                    # artist explicitly made it very transparent.
                    if float(value) < 0.15:
                        return True
                else:
                    # Transmission/specularTransmission: 0=opaque, 1=full glass.
                    # Raised from 0.15 to 0.5 — residual/default values on non-glass
                    # materials (aiStandardSurface conversion artifacts, preset leftovers)
                    # routinely sit between 0.1-0.3 and must not trigger glass rendering.
                    if float(value) > 0.5:
                        return True
        except Exception:
            continue
    return False


_MATERIALX_STACK_CACHE = None


def _find_materialx_stack_texture(context_name, exact_only=False):
    """Return the base-color texture from embedded Maya MaterialX stack records.

    Maya 2026 stores MaterialX lookdev documents as base64/zlib blobs on stack
    nodes. Some scenes do not expose those tiledimage nodes through normal
    listHistory traversal, so we decode the records and pick the record whose
    MaterialX document name matches the mesh/material context (Floor, Plant,
    Wooden_Piece, etc.).
    """
    if not context_name:
        return None

    records = _materialx_stack_records()
    if not records:
        return None

    labels = _texture_context_labels(context_name)
    matches = []
    for rec in records:
        score = _materialx_record_match_score(rec.get("name", ""), labels, context_name)
        if exact_only and score != 0:
            continue
        if score > 1:
            continue
        texture_path = _extract_materialx_base_texture(rec.get("xml", ""))
        if texture_path:
            matches.append((score, _texture_node_priority_from_path(texture_path), rec, texture_path))

    if not matches:
        return None

    matches.sort(key=lambda item: (item[0], item[1], item[2].get("name", "")))
    _score, _priority, rec, texture_path = matches[0]
    print("[RFX_MayaViewer] Found embedded MaterialX texture (%s): %s" % (
        rec.get("name", "MaterialX"), texture_path))
    result = {
        "node": "MaterialXStack:%s" % rec.get("name", "document"),
        "path": texture_path,
        "hash": _texture_hash(texture_path)
    }
    uv_u, uv_v = _extract_materialx_uv_tiling(rec.get("xml", ""), texture_path)
    if uv_u != 1.0 or uv_v != 1.0:
        result["uv_tiling_u"] = round(uv_u, 4)
        result["uv_tiling_v"] = round(uv_v, 4)
        print("[RFX_MayaViewer] MaterialX UV tiling %.4g x %.4g for %s" % (
            uv_u, uv_v, os.path.basename(texture_path)))
    return result


def _materialx_stack_records():
    global _MATERIALX_STACK_CACHE
    if _MATERIALX_STACK_CACHE is not None:
        return _MATERIALX_STACK_CACHE

    records = []
    seen = set()
    try:
        nodes = cmds.ls() or []
    except Exception:
        nodes = []

    for node in nodes:
        try:
            node_type = cmds.nodeType(node).lower()
        except Exception:
            node_type = ""
        if "materialx" not in node.lower() and "materialx" not in node_type and "mtlx" not in node.lower():
            # Stack records sometimes live on clearly named materialX nodes; this
            # guard keeps the attr scan reasonable in large production scenes.
            continue
        try:
            attrs = cmds.listAttr(node) or []
        except Exception:
            attrs = []
        for attr in attrs:
            try:
                value = cmds.getAttr(node + "." + attr)
            except Exception:
                continue
            for name, doc_b64 in _extract_materialx_doc_specs(value):
                key = (name, doc_b64[:48])
                if key in seen:
                    continue
                seen.add(key)
                xml = _decode_materialx_document(doc_b64)
                if xml:
                    records.append({"node": node, "name": name, "xml": xml})

    _MATERIALX_STACK_CACHE = records
    if records:
        print("[RFX_MayaViewer] Cached %d embedded MaterialX document(s)." % len(records))
    return records


def _extract_materialx_doc_specs(value):
    text = value if isinstance(value, str) else str(value)
    if '"document"' not in text or '"name"' not in text:
        return []
    # Maya stores these as JSON-ish snippets. The field order in observed 2026
    # scenes is document then name, but support both orders to keep it robust.
    specs = []
    patterns = (
        r'"document"\s*:\s*"([A-Za-z0-9+/=]+)"\s*,\s*"name"\s*:\s*"([^"]+)"',
        r'"name"\s*:\s*"([^"]+)"\s*,\s*"document"\s*:\s*"([A-Za-z0-9+/=]+)"',
    )
    for idx, pattern in enumerate(patterns):
        for match in re.finditer(pattern, text):
            if idx == 0:
                doc_b64, name = match.group(1), match.group(2)
            else:
                name, doc_b64 = match.group(1), match.group(2)
            specs.append((name, doc_b64))
    return specs


def _decode_materialx_document(doc_b64):
    try:
        raw = base64.b64decode(doc_b64)
    except Exception:
        return None

    candidates = [raw]
    if len(raw) > 4:
        candidates.append(raw[4:])

    for data in candidates:
        try:
            if data[:2] in (b"\x78\x9c", b"\x78\xda", b"\x78\x01"):
                data = zlib.decompress(data)
            text = data.decode("utf-8", "ignore")
            start = text.find("<")
            if start >= 0:
                text = text[start:]
            if "<materialx" in text.lower():
                return text
        except Exception:
            continue
    return None


def _materialx_record_match_score(record_name, labels, context_name):
    clean_record = record_name.split("|")[-1].split(":")[-1].lower()
    record_compact = clean_record.replace("_", "").replace("-", "").replace(" ", "")
    context_clean = context_name.split("|")[-1].split(":")[-1].lower().replace("shape", "")
    context_compact = context_clean.replace("_", "").replace("-", "").replace(" ", "")

    if record_compact == context_compact or record_compact in context_compact or context_compact in record_compact:
        return 0
    if any(label and label in clean_record for label in labels):
        return 1
    return 99


def _extract_materialx_base_texture(xml_text):
    try:
        root = ET.fromstring(xml_text)
    except Exception as e:
        print("[RFX_MayaViewer] MaterialX XML parse error: %s" % str(e))
        return None

    node_by_name = {}
    for elem in root.iter():
        name = elem.attrib.get("name")
        if name:
            node_by_name[name] = elem

    preferred_inputs = ("base_color", "baseColor", "diffuse_color", "diffuseColor", "color")
    for elem in root.iter():
        tag = _xml_local_name(elem.tag).lower()
        if tag not in ("standard_surface", "openpbr_surface", "surfacematerial", "shaderref"):
            continue
        for inp in list(elem):
            if _xml_local_name(inp.tag).lower() != "input":
                continue
            if inp.attrib.get("name") not in preferred_inputs:
                continue
            nodename = inp.attrib.get("nodename") or inp.attrib.get("node")
            if nodename:
                path = _materialx_texture_path_for_node(node_by_name.get(nodename), node_by_name)
                if path:
                    return path
            direct_value = inp.attrib.get("value")
            if direct_value and _looks_like_texture_path(direct_value):
                return direct_value

    candidates = []
    for elem in root.iter():
        tag = _xml_local_name(elem.tag).lower()
        if "image" not in tag:
            continue
        path = _materialx_texture_path_for_node(elem, node_by_name)
        if path:
            candidates.append(path)
    if candidates:
        candidates.sort(key=_texture_node_priority_from_path)
        return candidates[0]
    return None


def _extract_materialx_uv_tiling(xml_text, texture_path):
    """Return (uv_tiling_u, uv_tiling_v) from the tiledimage node that owns texture_path."""
    if not xml_text or not texture_path:
        return 1.0, 1.0
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return 1.0, 1.0

    target = os.path.basename(texture_path).lower()
    for elem in root.iter():
        tag = _xml_local_name(elem.tag).lower()
        if tag not in ("tiledimage", "image"):
            continue
        has_file = False
        for inp in list(elem):
            if _xml_local_name(inp.tag).lower() != "input":
                continue
            if inp.attrib.get("name", "").lower() in ("file", "filename"):
                val = inp.attrib.get("value", "")
                if os.path.basename(val).lower() == target:
                    has_file = True
                    break
        if not has_file:
            continue
        for inp in list(elem):
            if _xml_local_name(inp.tag).lower() != "input":
                continue
            if inp.attrib.get("name", "").lower() == "uvtiling":
                parts = inp.attrib.get("value", "").replace(",", " ").split()
                try:
                    if len(parts) >= 2:
                        return float(parts[0]), float(parts[1])
                    if len(parts) == 1:
                        v = float(parts[0])
                        return v, v
                except ValueError:
                    pass
    return 1.0, 1.0


def _materialx_texture_path_for_node(elem, node_by_name):
    if elem is None:
        return None
    for inp in list(elem):
        if _xml_local_name(inp.tag).lower() != "input":
            continue
        input_name = inp.attrib.get("name", "").lower()
        if input_name in ("file", "filename"):
            value = inp.attrib.get("value")
            if value:
                return value
        nodename = inp.attrib.get("nodename") or inp.attrib.get("node")
        if nodename:
            nested = _materialx_texture_path_for_node(node_by_name.get(nodename), node_by_name)
            if nested:
                return nested
    return None


def _xml_local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _looks_like_texture_path(value):
    ext = os.path.splitext(value)[1].lower()
    return ext in (_IOS_READABLE_EXTS | _QT_CONVERTIBLE_EXTS | {".tx"})


def _texture_node_priority_from_path(path):
    lower = (path or "").lower()
    preferred = ("base", "diff", "albedo", "col", "color", "colour", "label", "decal")
    rejected = ("rough", "gloss", "metal", "spec", "normal", "nrm", "bump", "height", "disp", "sss", "refl")
    if any(token in lower for token in preferred):
        return 0
    if any(token in lower for token in rejected):
        return 2
    return 1


def _find_material_texture(mat_node, sg_name=None, context_name=None, allow_scene_scan=False, skip_nodes=None):
    """Fallback for unusual/MaterialX networks: choose the most likely base texture."""
    embedded = _find_materialx_stack_texture(context_name or sg_name or mat_node)
    if embedded:
        return embedded

    skip_nodes = skip_nodes or set()

    try:
        upstream = cmds.listHistory(mat_node) or []
    except Exception:
        upstream = []

    texture_nodes = [
        n for n in upstream
        if n not in skip_nodes and _is_texture_node(n) and _get_texture_node_path(n)
    ]
    scene_scan = False
    if allow_scene_scan and not texture_nodes:
        try:
            texture_nodes = [
                n for n in (cmds.ls() or [])
                if n not in skip_nodes and _is_texture_node(n) and _get_texture_node_path(n)
            ]
            scene_scan = True
        except Exception:
            texture_nodes = []

    texture_nodes.sort(key=_texture_node_priority)
    if sg_name or mat_node or context_name:
        texture_nodes.sort(key=lambda n: _texture_node_material_match_priority(
            n, mat_node, sg_name, context_name
        ))
    if scene_scan:
        texture_nodes = [
            n for n in texture_nodes
            if _texture_node_material_match_priority(n, mat_node, sg_name, context_name) == 0
        ]

    if texture_nodes:
        node = texture_nodes[0]
        tex_path = _get_texture_node_path(node)
        print("[RFX_MayaViewer] Found fallback texture (%s): %s" % (
            cmds.nodeType(node), tex_path))
        return {"node": node, "path": tex_path, "hash": _texture_hash(tex_path)}
    return None


def _is_materialx_shader_node(node):
    try:
        lower = cmds.nodeType(node).lower()
    except Exception:
        return False
    return "materialx" in lower or lower.startswith("nd_") or lower in ("standard_surface", "surfacematerial")


def _texture_node_material_match_priority(node, mat_node=None, sg_name=None, context_name=None):
    haystack = "%s %s" % (node.lower(), (_get_texture_node_path(node) or "").lower())
    labels = []
    for value in (mat_node, sg_name, context_name):
        if not value:
            continue
        labels.extend(_texture_context_labels(value))

    labels = [l for l in labels if l and l not in _GENERIC_TEXTURE_CONTEXT_LABELS]
    if any(label in haystack for label in labels):
        return 0
    return 1


_GENERIC_TEXTURE_CONTEXT_LABELS = {
    "base", "color", "colour", "col", "diff", "diffuse", "texture", "tex", "material", "mat"
}


def _texture_context_labels(value):
    clean = value.split("|")[-1].split(":")[-1].lower()
    clean = clean.replace("shape", "")
    compact = clean.replace("_", "").replace("-", "").replace(" ", "")
    labels = [clean, compact, clean.replace("_", " "), clean.replace("-", " ")]

    tokens = [t for t in clean.replace("-", "_").replace(" ", "_").split("_") if t]
    labels.extend(t for t in tokens if len(t) >= 4)

    aliases = {
        "wooden": ["wood", "tree", "trunk", "dead_tree"],
        "piece": ["wood", "tree", "trunk"],
        "floor": ["floor", "ground", "concrete", "wall"],
        "plant": ["plant", "leaf", "leaves", "monstera"],
        "base": [],
        "shell": ["shell", "lambis"],
        "rock": ["rock", "moss"],
        "glass": ["glass", "bottle", "parfum", "snap", "label"],
        "label": ["label", "snap", "bottle", "parfum"],
        "bottle": ["bottle", "parfum", "snap", "label"],
    }
    for token in tokens:
        labels.extend(aliases.get(token, []))

    return list(dict.fromkeys(labels))


def _find_upstream_texture_node(plug, visited=None, depth=0):
    """Walk upstream from a shader color plug and return the nearest image node."""
    if visited is None:
        visited = set()
    if depth > 24 or not plug:
        return None

    current_node = plug.split(".")[0]
    try:
        if _is_texture_node(current_node):
            return current_node
    except Exception:
        pass

    src_plugs = cmds.listConnections(
        plug, source=True, destination=False, plugs=True
    ) or []
    for src_plug in src_plugs:
        node = src_plug.split(".")[0]
        if node in visited:
            continue
        visited.add(node)

        if _is_texture_node(node):
            return node

        upstream_plugs = cmds.listConnections(
            node, source=True, destination=False, plugs=True
        ) or []
        upstream_plugs.sort(key=_plug_priority)
        for upstream in upstream_plugs:
            found = _find_upstream_texture_node(upstream, visited, depth + 1)
            if found:
                return found
    return None


def _plug_priority(plug):
    lower = plug.lower()
    preferred = ("base", "diff", "albedo", "color", "colour", "label", "decal")
    rejected = ("rough", "gloss", "metal", "spec", "normal", "nrm", "bump", "height", "disp")
    if any(token in lower for token in preferred):
        return 0
    if any(token in lower for token in rejected):
        return 2
    return 1


def _texture_node_priority(node):
    path = (_get_texture_node_path(node) or node).lower()
    preferred = ("base", "diff", "albedo", "col", "color", "colour", "label", "decal")
    rejected = ("rough", "gloss", "metal", "spec", "normal", "nrm", "bump", "height", "disp", "sss", "refl")
    if any(token in path for token in preferred):
        return 0
    if any(token in path for token in rejected):
        return 2
    return 1


def _is_texture_node(node):
    """True for Maya/Arnold/MaterialX image nodes that can carry a file path."""
    try:
        node_type = cmds.nodeType(node)
    except Exception:
        return False
    lower = node_type.lower()
    if node_type in ("file", "aiImage"):
        return True
    if "tiledimage" in lower:
        return True
    if "image" in lower and _get_texture_node_path(node):
        return True
    return False


def _get_texture_node_path(node):
    for attr in _TEXTURE_PATH_ATTRS:
        plug = node + "." + attr
        try:
            if not cmds.objExists(plug):
                continue
            path = cmds.getAttr(plug) or ""
            return path.strip() or None
        except Exception:
            continue
    return None


def _texture_hash(path, matte_color=None):
    """Stable 16-char hex key for a texture (keyed on path string)."""
    key = path
    if matte_color is not None:
        key = "%s|matte=%s" % (
            path,
            ",".join("%.4f" % float(c) for c in matte_color[:3])
        )
    return hashlib.md5(key.encode("utf-8")).hexdigest()[:16]


def _attach_texture_matte(texture, color):
    """Mark a texture to be flattened over a material color before transport."""
    try:
        matte = [float(color[i]) if i < len(color) else 0.0 for i in range(3)]
    except Exception:
        matte = [0.0, 0.0, 0.0]
    texture["matte_color"] = matte
    if texture.get("path"):
        texture["hash"] = _texture_hash(texture["path"], matte)


# iOS-decodable formats (UIImage / ImageIO)
_IOS_READABLE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif"}
_QT_CONVERTIBLE_EXTS = {".psd", ".psb", ".exr", ".hdr", ".tga"}
_TEXTURE_PATH_ATTRS = (
    "fileTextureName",  # Maya file
    "filename",         # Arnold aiImage
    "file",             # MaterialX tiledimage/image nodes
)


def _resolve_ios_texture_path(path):
    """Return an iOS-decodable path for the given texture.

    Arnold's .tx files are not decodable by iOS UIImage. For .tx (and other
    non-decodable formats) we look for a sibling source file — same base name
    but with a PNG/JPEG/TIFF extension — and return that instead.
    UDIM paths (containing <UDIM>) are resolved to tile 1001 first.
    If nothing readable is found, returns None.
    """
    if not path:
        return None

    # UDIM: replace <UDIM> placeholder with tile 1001 and try that path
    if "<UDIM>" in path:
        resolved = path.replace("<UDIM>", "1001")
        result = _resolve_ios_texture_path(resolved)
        if result:
            print("[RFX_MayaViewer] UDIM resolved to tile 1001: %s" % result)
            return result
        print("[RFX_MayaViewer] UDIM tile 1001 not found for: %s" % path)
        return None

    path = _expand_texture_path(path)
    ext = os.path.splitext(path)[1].lower()
    if ext in _IOS_READABLE_EXTS:
        if os.path.isfile(path):
            return path
        print("[RFX_MayaViewer] Texture file not found on disk: %s" % path)
        return None

    if ext in _QT_CONVERTIBLE_EXTS:
        if os.path.isfile(path):
            return path
        print("[RFX_MayaViewer] Convertible texture file not found on disk: %s" % path)
        return None

    # Non-readable (e.g. .tx, .exr, .hdr) — search for a source sibling
    base = os.path.splitext(path)[0]
    for src_ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff"):
        candidate = base + src_ext
        if os.path.isfile(candidate):
            print("[RFX_MayaViewer] Using source texture instead of %s: %s" % (ext, candidate))
            return candidate
    print("[RFX_MayaViewer] No iOS-readable texture for: %s" % path)
    return None


def _expand_texture_path(path):
    """Resolve env/workspace/scene-relative texture paths from Maya/MaterialX."""
    if not path:
        return path

    raw = os.path.expanduser(os.path.expandvars(path.strip()))
    candidates = [raw]

    try:
        expanded = cmds.workspace(expandName=raw)
        if expanded and expanded not in candidates:
            candidates.append(expanded)
    except Exception:
        pass

    if not os.path.isabs(raw):
        try:
            scene_path = cmds.file(query=True, sceneName=True) or ""
        except Exception:
            scene_path = ""
        if scene_path:
            scene_dir = os.path.dirname(scene_path)
            for base_dir in (scene_dir, os.path.dirname(scene_dir)):
                candidate = os.path.normpath(os.path.join(base_dir, raw))
                if candidate not in candidates:
                    candidates.append(candidate)

    for candidate in candidates:
        if os.path.isfile(candidate):
            if candidate != path:
                print("[RFX_MayaViewer] Resolved texture path: %s -> %s" % (path, candidate))
            return candidate
    return candidates[-1]


def _texture_mime_for_path(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".png":
        return "image/png"
    if ext in (".tif", ".tiff"):
        return "image/tiff"
    if ext == ".gif":
        return "image/gif"
    if ext == ".bmp":
        return "image/bmp"
    return "image/jpeg"


def _read_texture_payload_for_ios(path, matte_color=None):
    """Resolve path, read mobile-friendly bytes, and return (data, mime)."""
    try:
        readable = _resolve_ios_texture_path(path)
        if not readable:
            print("[RFX_MayaViewer] No iOS-readable version found for: %s" % path)
            return None
        if not os.path.isfile(readable):
            print("[RFX_MayaViewer] Texture file not found: %s" % readable)
            return None
        source_size = os.path.getsize(readable)
        payload = _read_texture_bytes_for_ios(readable, matte_color=matte_color)
        if not payload:
            return None
        data, mime = payload
        print("[RFX_MayaViewer] Sending texture (%d KB, source %d KB, %s): %s" % (
            len(data) // 1024, source_size // 1024, mime, readable))
        return data, mime
    except Exception as e:
        print("[RFX_MayaViewer] Texture read error: %s" % str(e))
        return None


def _read_texture_b64(path, matte_color=None):
    """Resolve path to an iOS-readable format, read it, and return base64 string."""
    payload = _read_texture_payload_for_ios(path, matte_color=matte_color)
    if payload is None:
        return None
    data, _mime = payload
    return base64.b64encode(data).decode("ascii")


def _read_texture_bytes_for_ios(path, matte_color=None):
    """Read texture bytes, resizing large images when Qt image support is available."""
    size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()

    if matte_color is not None or ext not in _IOS_READABLE_EXTS:
        converted = _resize_texture_with_qt(path, matte_color=matte_color)
        if converted:
            return converted
        print("[RFX_MayaViewer] Texture format requires conversion but Qt could not read: %s" % path)
        return None

    if size <= _TARGET_TEXTURE_BYTES:
        with open(path, "rb") as f:
            return f.read(), _texture_mime_for_path(path)

    resized = _resize_texture_with_qt(path, matte_color=matte_color)
    if resized:
        return resized

    if size <= _MAX_TEXTURE_BYTES:
        print("[RFX_MayaViewer] Sending large texture without resize; Qt image resize unavailable.")
        with open(path, "rb") as f:
            return f.read(), _texture_mime_for_path(path)

    print("[RFX_MayaViewer] Texture too large and could not resize (%d MB): %s" % (
        size // (1024*1024), path))
    return None


def _resize_texture_with_qt(path, matte_color=None):
    """Resize/compress a readable image to mobile-friendly bytes."""
    try:
        try:
            from PySide6 import QtCore, QtGui
        except Exception:
            from PySide2 import QtCore, QtGui

        image = QtGui.QImage(path)
        if image.isNull():
            return None

        flattened_alpha = False
        if matte_color is not None and image.hasAlphaChannel():
            try:
                r = max(0, min(255, int(round(float(matte_color[0]) * 255.0))))
                g = max(0, min(255, int(round(float(matte_color[1]) * 255.0))))
                b = max(0, min(255, int(round(float(matte_color[2]) * 255.0))))
            except Exception:
                r = g = b = 0
            composed = QtGui.QImage(image.size(), QtGui.QImage.Format_RGB888)
            composed.fill(QtGui.QColor(r, g, b))
            painter = QtGui.QPainter(composed)
            painter.drawImage(0, 0, image)
            painter.end()
            image = composed
            flattened_alpha = True
            print("[RFX_MayaViewer] Flattened alpha texture over matte RGB(%d,%d,%d): %s" % (
                r, g, b, path))

        width = image.width()
        height = image.height()
        longest = max(width, height)
        if longest > _MAX_TEXTURE_DIMENSION:
            scale = float(_MAX_TEXTURE_DIMENSION) / float(longest)
            image = image.scaled(
                max(1, int(width * scale)),
                max(1, int(height * scale)),
                QtCore.Qt.KeepAspectRatio,
                QtCore.Qt.SmoothTransformation
            )

        # Preserve un-matted alpha images as PNG when practical. For connected
        # base-color decals, matte_color is provided and JPEG is intentional.
        if matte_color is None and image.hasAlphaChannel():
            byte_array = QtCore.QByteArray()
            buffer = QtCore.QBuffer(byte_array)
            buffer.open(QtCore.QIODevice.WriteOnly)
            ok = image.save(buffer, "PNG")
            buffer.close()
            if ok:
                data = bytes(byte_array)
                if len(data) <= _MAX_TEXTURE_BYTES:
                    print("[RFX_MayaViewer] Resized texture to %dx%d PNG with alpha" % (
                        image.width(), image.height()))
                    return data, "image/png"

        for quality in (86, 76, 66, 56):
            byte_array = QtCore.QByteArray()
            buffer = QtCore.QBuffer(byte_array)
            buffer.open(QtCore.QIODevice.WriteOnly)
            ok = image.save(buffer, "JPG", quality)
            buffer.close()
            if not ok:
                continue
            data = bytes(byte_array)
            if len(data) <= _TARGET_TEXTURE_BYTES or quality == 56:
                matte_note = " (matte alpha)" if flattened_alpha else ""
                print("[RFX_MayaViewer] Resized texture to %dx%d JPEG q%d%s" % (
                    image.width(), image.height(), quality, matte_note))
                return data, "image/jpeg"
    except Exception as e:
        print("[RFX_MayaViewer] Qt texture resize unavailable: %s" % str(e))
    return None


def _collect_texture_refs(payload):
    """Return list of (hash, path, matte_color) for unique referenced textures."""
    seen = set()
    result = []
    for mesh in payload.get("meshes", []):
        groups = mesh.get("face_groups") or []
        mats = [g["material"] for g in groups if g.get("material")]
        if not mats:
            m = mesh.get("material")
            if m:
                mats = [m]
        for mat in mats:
            tex = mat.get("diffuse_texture")
            if tex and tex.get("path"):
                matte_color = tex.get("matte_color")
                h = tex.get("hash") or _texture_hash(tex["path"], matte_color)
                if h not in seen:
                    seen.add(h)
                    result.append((h, tex["path"], matte_color))
    return result


def _broadcast_new_textures(payload):
    """Send any not-yet-broadcast texture data to all connected clients."""
    global _SENT_TEXTURE_HASHES
    if _SERVER_STOP_EVENT.is_set():
        return
    for tex_hash, path, matte_color in _collect_texture_refs(payload):
        if _SERVER_STOP_EVENT.is_set():
            return
        if tex_hash in _SENT_TEXTURE_HASHES:
            continue
        texture_payload = _read_texture_payload_for_ios(path, matte_color=matte_color)
        if texture_payload is None:
            continue
        data, mime = texture_payload
        b64 = base64.b64encode(data).decode("ascii")
        msg = json.dumps({"type": "texture_data", "hash": tex_hash, "mime": mime, "data": b64})
        with _CLIENTS_LOCK:
            dead = []
            for sock in _CLIENTS:
                try:
                    _send_scene_json(sock, msg)
                except Exception:
                    dead.append(sock)
            for sock in dead:
                _CLIENTS.remove(sock)
        _SENT_TEXTURE_HASHES.add(tex_hash)


def _send_textures_to_client(sock, payload):
    """Send all textures in payload to a specific client socket."""
    if _SERVER_STOP_EVENT.is_set():
        return
    for tex_hash, path, matte_color in _collect_texture_refs(payload):
        if _SERVER_STOP_EVENT.is_set():
            return
        texture_payload = _read_texture_payload_for_ios(path, matte_color=matte_color)
        if texture_payload is None:
            continue
        data, mime = texture_payload
        b64 = base64.b64encode(data).decode("ascii")
        msg = json.dumps({"type": "texture_data", "hash": tex_hash, "mime": mime, "data": b64})
        try:
            _send_scene_json(sock, msg)
        except Exception:
            break


def _collect_lights():
    selected_transforms = None
    if _SELECTED_ONLY:
        selected_transforms = set(cmds.ls(selection=True, long=True) or [])

    result = []
    light_types = ["areaLight", "directionalLight", "pointLight", "spotLight",
                   "aiAreaLight", "aiSkyDomeLight"]

    for lt in light_types:
        shapes = cmds.ls(type=lt, long=True) or []
        for shape in shapes:
            parents = cmds.listRelatives(shape, parent=True, fullPath=True)
            if not parents:
                continue
            transform = parents[0]

            if selected_transforms is not None and transform not in selected_transforms:
                continue

            try:
                pos_list = cmds.xform(transform, query=True, worldSpace=True, translation=True)
                rot_list = cmds.xform(transform, query=True, worldSpace=True, rotation=True)
                world_matrix = cmds.xform(transform, query=True, worldSpace=True, matrix=True)
                # Maya/Arnold lights emit down local -Z. Export the evaluated world
                # direction so SceneKit does not have to guess Maya's Euler order.
                direction_list = [
                    -float(world_matrix[8]),
                    -float(world_matrix[9]),
                    -float(world_matrix[10])
                ]
                direction_len = math.sqrt(
                    direction_list[0] * direction_list[0] +
                    direction_list[1] * direction_list[1] +
                    direction_list[2] * direction_list[2]
                )
                if direction_len > 0.00001:
                    direction_list = [v / direction_len for v in direction_list]
                else:
                    direction_list = [0.0, 0.0, -1.0]

                intensity = 1.0
                try:
                    intensity = cmds.getAttr(shape + ".intensity") or 1.0
                except Exception:
                    pass

                # Arnold lights have an exposure (EV stops) that multiplies intensity.
                # Keep the same authored exposure for environment lights too, but
                # protect ambient/skydome entries from the direct-light normalization
                # pass below so a very bright area light does not erase HDR fill.
                try:
                    exposure = 0.0
                    if cmds.objExists(shape + ".exposure"):
                        exposure = cmds.getAttr(shape + ".exposure") or 0.0
                    # Maya native lights have .exposure=0.0 by default while Arnold adds
                    # .aiExposure for the actual EV stops value.  Use elif-style logic
                    # but allow the second check when the first attr exists but is zero.
                    if exposure == 0.0 and cmds.objExists(shape + ".aiExposure"):
                        exposure = cmds.getAttr(shape + ".aiExposure") or 0.0

                    if exposure != 0.0:
                        intensity = intensity * (2.0 ** float(exposure))
                except Exception:
                    pass

                color = [1.0, 1.0, 1.0]
                try:
                    c = cmds.getAttr(shape + ".color")[0]
                    color = [round(c[0], 4), round(c[1], 4), round(c[2], 4)]
                    # Arnold lights sometimes report color=[0,0,0] when the visible
                    # swatch is connected/checkerboard-driven, or when Maya's light
                    # editor is using the default white emission path. A black light
                    # with high exposure contributes nothing in SceneKit, which made
                    # Voyage Lights ON look almost identical to Lights OFF.
                    if max(color) < 0.001:
                        try:
                            connected = cmds.listConnections(shape + ".color", source=True) or []
                            if connected or lt in ("aiAreaLight", "aiSkyDomeLight"):
                                color = [1.0, 1.0, 1.0]
                        except Exception:
                            if lt in ("aiAreaLight", "aiSkyDomeLight"):
                                color = [1.0, 1.0, 1.0]
                except Exception:
                    pass

                decay_rate = 0
                try:
                    if cmds.objExists(shape + ".decayRate"):
                        decay_rate = int(cmds.getAttr(shape + ".decayRate") or 0)
                except Exception:
                    pass

                width = height = None
                if lt in ("areaLight", "aiAreaLight"):
                    try:
                        width  = cmds.getAttr(transform + ".scaleX") * 2.0
                        height = cmds.getAttr(transform + ".scaleY") * 2.0
                    except Exception:
                        width = height = 1.0

                cone_angle = penumbra_angle = None
                spread_value = None
                if lt == "spotLight":
                    try:
                        cone_angle = cmds.getAttr(shape + ".coneAngle")
                    except Exception:
                        pass
                    try:
                        penumbra_angle = cmds.getAttr(shape + ".penumbraAngle")
                    except Exception:
                        pass
                elif lt in ("areaLight", "aiAreaLight"):
                    # Area lights emit in a hemisphere. We map them to wide spot lights for SceneKit.
                    cone_angle = 180.0
                    penumbra_angle = 0.0
                    if lt == "aiAreaLight":
                        try:
                            if cmds.objExists(shape + ".aiSpread"):
                                spread_value = cmds.getAttr(shape + ".aiSpread")
                            elif cmds.objExists(shape + ".spread"):
                                spread_value = cmds.getAttr(shape + ".spread")
                        except Exception:
                            pass
                        
                        try:
                            if cmds.objExists(shape + ".normalize") and not cmds.getAttr(shape + ".normalize"):
                                intensity = intensity * (float(width) * float(height))
                        except Exception:
                            pass

                light_entry = {
                    "name":       transform.split("|")[-1],
                    "type":       _light_type_string(lt),
                    "position":   [round(p, 5) for p in pos_list],
                    "rotation":   [round(r, 5) for r in rot_list],
                    "direction":  [round(d, 6) for d in direction_list],
                    "color":      color,
                    "intensity":  round(float(intensity), 4),
                    "decay_rate": decay_rate
                }
                if width is not None:
                    light_entry["width"]  = round(float(width), 4)
                    light_entry["height"] = round(float(height), 4)
                if cone_angle is not None:
                    light_entry["cone_angle"] = round(float(cone_angle), 2)
                if penumbra_angle is not None:
                    light_entry["penumbra_angle"] = round(float(penumbra_angle), 2)
                if spread_value is not None:
                    # Keep Arnold spread available for diagnostics, but do not map it
                    # directly to a SceneKit cone. Maya's viewport/Arnold area lights
                    # remain broad even at low spread values in our reference scenes.
                    light_entry["spread"] = round(float(spread_value), 4)

                result.append(light_entry)

            except Exception as e:
                print("[RFX_MayaViewer] Light error %s: %s" % (shape, str(e)))

    # Normalize direct-light intensities so the brightest direct light ≤ 10.0.
    # Arnold exposure-folded intensities can be in the thousands (2^14=16384).
    # Keep ambient/skydome lights out of this scale. They represent environment
    # fill, and scaling them by a hot area light makes Voyage-style HDR setups
    # render crushed and grey in the mobile viewer.
    if result:
        direct_lights = [l for l in result if l.get("type") != "ambient"]
        max_intensity = max((l["intensity"] for l in direct_lights), default=0.0)
        if max_intensity > 10.0:
            scale = 10.0 / max_intensity
            for l in direct_lights:
                l["intensity"] = round(l["intensity"] * scale, 6)

    return result


def _light_type_string(maya_type):
    mapping = {
        "areaLight":        "area",
        "aiAreaLight":      "area",
        "directionalLight": "directional",
        "pointLight":       "point",
        "spotLight":        "spot",
        "aiSkyDomeLight":   "ambient"
    }
    return mapping.get(maya_type, "point")


def _render_resolution():
    """Return Maya render resolution and aspect ratio for camera gate matching."""
    width = 1
    height = 1
    try:
        width = int(cmds.getAttr("defaultResolution.width") or 1)
        height = int(cmds.getAttr("defaultResolution.height") or 1)
    except Exception:
        pass
    width = max(width, 1)
    height = max(height, 1)
    return width, height, round(float(width) / float(height), 6)


def _camera_payload(cam_transform):
    """Build a camera dict from a Maya camera transform node."""
    pos = cmds.xform(cam_transform, query=True, worldSpace=True, translation=True)
    fov = cmds.camera(cam_transform, query=True, horizontalFieldOfView=True)
    try:
        vertical_fov = cmds.camera(cam_transform, query=True, verticalFieldOfView=True)
    except Exception:
        vertical_fov = fov
    try:
        horizontal_aperture = cmds.camera(cam_transform, query=True, horizontalFilmAperture=True)
        vertical_aperture = cmds.camera(cam_transform, query=True, verticalFilmAperture=True)
    except Exception:
        horizontal_aperture = 1.0
        vertical_aperture = 1.0
    try:
        fit_resolution_gate = cmds.camera(cam_transform, query=True, filmFit=True)
    except Exception:
        fit_resolution_gate = "fill"
    rot = cmds.xform(cam_transform, query=True, worldSpace=True, rotation=True)
    rx = math.radians(rot[0])
    ry = math.radians(rot[1])
    forward_x = -math.sin(ry) * math.cos(rx)
    forward_y =  math.sin(rx)
    forward_z = -math.cos(ry) * math.cos(rx)
    dist = 5.0
    target = [
        pos[0] + forward_x * dist,
        pos[1] + forward_y * dist,
        pos[2] + forward_z * dist
    ]
    resolution_width, resolution_height, aspect_ratio = _render_resolution()
    return {
        "name":              cam_transform.split("|")[-1],
        "position":          [round(p, 5) for p in pos],
        "target":            [round(t, 5) for t in target],
        "fov":               round(float(fov), 2),
        "vertical_fov":      round(float(vertical_fov), 2),
        "film_aspect_ratio": round(float(horizontal_aperture) / max(float(vertical_aperture), 0.0001), 6),
        "fit_resolution_gate": str(fit_resolution_gate),
        "resolution_width":  resolution_width,
        "resolution_height": resolution_height,
        "aspect_ratio":      aspect_ratio
    }


def _collect_active_camera():
    """Return the camera from the currently focused viewport."""
    try:
        panels = cmds.getPanel(type="modelPanel") or []
        if not panels:
            return None

        # Prefer the focused panel; fall back to the first perspective panel
        focused = cmds.getPanel(withFocus=True) or ""
        if focused in panels:
            panel = focused
        else:
            panel = panels[0]
            for p in panels:
                cam = cmds.modelEditor(p, query=True, camera=True) or ""
                if cam not in ("top", "front", "side"):
                    panel = p
                    break

        cam_transform = cmds.modelEditor(panel, query=True, camera=True)
        if not cam_transform:
            return None
        return _camera_payload(cam_transform)
    except Exception as e:
        print("[RFX_MayaViewer] Camera error: %s" % str(e))
        return None


# Default Maya camera names — not shown in the user camera list
_DEFAULT_CAMERAS = {"persp", "top", "front", "side",
                    "perspShape", "topShape", "frontShape", "sideShape"}


def _collect_user_cameras():
    """Return all user-created cameras in the scene (excludes Maya defaults)."""
    result = []
    for cam_transform in (cmds.listCameras() or []):
        if cam_transform in _DEFAULT_CAMERAS:
            continue
        shapes = cmds.listRelatives(cam_transform, shapes=True) or []
        if any(s in _DEFAULT_CAMERAS for s in shapes):
            continue
        try:
            result.append(_camera_payload(cam_transform))
        except Exception as e:
            print("[RFX_MayaViewer] User camera error %s: %s" % (cam_transform, str(e)))
    return result


# ---------------------------------------------------------------------------
# Live sync callbacks
# ---------------------------------------------------------------------------

def _register_callbacks():
    global _CALLBACK_IDS
    _unregister_callbacks()

    try:
        cb = om.MEventMessage.addEventCallback("SceneOpened", _on_scene_changed)
        _CALLBACK_IDS.append(cb)
        cb = om.MEventMessage.addEventCallback("SceneSaved", _on_scene_changed)
        _CALLBACK_IDS.append(cb)
        cb = om.MEventMessage.addEventCallback("timeChanged", _on_scene_changed)
        _CALLBACK_IDS.append(cb)
        cb = om.MEventMessage.addEventCallback("NameChanged", _on_scene_changed)
        _CALLBACK_IDS.append(cb)
        # Push selection changes only when selected-only mode is active. In full-scene
        # mode, a Maya selection should not trigger a 30MB scene export.
        cb = om.MEventMessage.addEventCallback("SelectionChanged", _on_selection_changed)
        _CALLBACK_IDS.append(cb)
    except Exception as e:
        print("[RFX_MayaViewer] Callback registration error: %s" % str(e))


def _unregister_callbacks():
    global _CALLBACK_IDS
    for cb_id in _CALLBACK_IDS:
        try:
            om.MMessage.removeCallback(cb_id)
        except Exception:
            pass
    _CALLBACK_IDS = []


def _on_scene_changed(*args):
    if time.time() < _SUPPRESS_SCENE_CALLBACK_UNTIL:
        return
    if _LIVE_SYNC and _clients_connected():
        _queue_live_sync_snapshot()


def _on_selection_changed(*args):
    if not _SELECTED_ONLY:
        return
    _on_scene_changed(*args)


def _queue_live_sync_snapshot():
    global _LIVE_SYNC_PENDING
    if _LIVE_SYNC_PENDING:
        return
    _LIVE_SYNC_PENDING = True
    # Defer slightly to let Maya finish its operation
    cmds.evalDeferred(_deferred_send, lowestPriority=True)


def _deferred_send():
    global _LIVE_SYNC_PENDING
    _LIVE_SYNC_PENDING = False
    if time.time() < _SUPPRESS_SCENE_CALLBACK_UNTIL:
        return
    send_snapshot()


def _resolve_transform_target(obj):
    """Resolve a viewer object identifier to a transform that Maya can edit."""
    if not obj:
        return None

    candidates = []
    if cmds.objExists(obj):
        candidates.append(obj)

    short_name = obj.split("|")[-1].split(":")[-1]
    for pattern in (obj.split("|")[-1], short_name):
        try:
            matches = cmds.ls(pattern, long=True) or []
            candidates.extend(matches)
        except Exception:
            pass

    seen = set()
    for candidate in candidates:
        if candidate in seen or not cmds.objExists(candidate):
            continue
        seen.add(candidate)

        try:
            node_type = cmds.nodeType(candidate)
        except Exception:
            node_type = None

        if node_type == "transform":
            return candidate

        if node_type == "mesh":
            parents = cmds.listRelatives(candidate, parent=True, fullPath=True) or []
            if parents and cmds.objExists(parents[0]):
                return parents[0]

    return None


def _capture_transform_state(target):
    return {
        "target": target,
        "matrix": cmds.xform(target, query=True, worldSpace=True, matrix=True)
    }


def _restore_transform_state(state):
    target = _resolve_transform_target(state.get("target"))
    if not target:
        print("[RFX_MayaViewer] Transform history target not found: %s" % state.get("target"))
        return False

    cmds.xform(target, worldSpace=True, matrix=state.get("matrix"))
    return True


def _states_differ(a, b):
    ma = a.get("matrix") or []
    mb = b.get("matrix") or []
    if len(ma) != len(mb):
        return True
    return any(abs(float(x) - float(y)) > 0.00001 for x, y in zip(ma, mb))


def _push_transform_history(before, after):
    global _TRANSFORM_UNDO_STACK, _TRANSFORM_REDO_STACK
    if not _states_differ(before, after):
        return
    _TRANSFORM_UNDO_STACK.append({"before": before, "after": after})
    if len(_TRANSFORM_UNDO_STACK) > _TRANSFORM_HISTORY_LIMIT:
        _TRANSFORM_UNDO_STACK = _TRANSFORM_UNDO_STACK[-_TRANSFORM_HISTORY_LIMIT:]
    _TRANSFORM_REDO_STACK = []


def _transform_undo():
    if not _TRANSFORM_UNDO_STACK:
        print("[RFX_MayaViewer] Transform undo: no history")
        return

    entry = _TRANSFORM_UNDO_STACK.pop()
    try:
        cmds.undoInfo(openChunk=True)
        if _restore_transform_state(entry["before"]):
            _TRANSFORM_REDO_STACK.append(entry)
            print("[RFX_MayaViewer] Transform undo: %s" % entry["before"].get("target"))
    except Exception as e:
        print("[RFX_MayaViewer] Transform undo failed: %s" % str(e))
    finally:
        try:
            cmds.undoInfo(closeChunk=True)
        except Exception:
            pass

    send_snapshot()


def _transform_redo():
    if not _TRANSFORM_REDO_STACK:
        print("[RFX_MayaViewer] Transform redo: no history")
        return

    entry = _TRANSFORM_REDO_STACK.pop()
    try:
        cmds.undoInfo(openChunk=True)
        if _restore_transform_state(entry["after"]):
            _TRANSFORM_UNDO_STACK.append(entry)
            print("[RFX_MayaViewer] Transform redo: %s" % entry["after"].get("target"))
    except Exception as e:
        print("[RFX_MayaViewer] Transform redo failed: %s" % str(e))
    finally:
        try:
            cmds.undoInfo(closeChunk=True)
        except Exception:
            pass

    send_snapshot()


def _apply_transform_delta(data):
    """Apply a relative transform from the iOS viewer to a Maya transform."""
    global _SUPPRESS_SCENE_CALLBACK_UNTIL
    obj = data.get("object") or ""
    transform_id = data.get("transform_id")
    target = _resolve_transform_target(obj)
    if not target:
        print("[RFX_MayaViewer] Transform target not found: %s" % obj)
        return

    translate = data.get("translate")
    rotate = data.get("rotate")
    scale = data.get("scale")

    try:
        _SUPPRESS_SCENE_CALLBACK_UNTIL = time.time() + 1.0
        before = _capture_transform_state(target)
        cmds.undoInfo(openChunk=True)
        if isinstance(translate, (list, tuple)) and len(translate) >= 3:
            delta = [float(translate[0]), float(translate[1]), float(translate[2])]
            cmds.xform(target, relative=True, worldSpace=True, translation=delta)

        if isinstance(rotate, (list, tuple)) and len(rotate) >= 3:
            delta = [float(rotate[0]), float(rotate[1]), float(rotate[2])]
            cmds.rotate(delta[0], delta[1], delta[2], target, relative=True, worldSpace=True)

        if scale is not None:
            if isinstance(scale, (list, tuple)) and len(scale) >= 3:
                factors = [
                    max(0.001, float(scale[0])),
                    max(0.001, float(scale[1])),
                    max(0.001, float(scale[2])),
                ]
                cmds.scale(factors[0], factors[1], factors[2], target, relative=True)
            else:
                factor = max(0.001, float(scale))
                cmds.scale(factor, factor, factor, target, relative=True)

        print("[RFX_MayaViewer] Applied transform to %s: translate=%s rotate=%s scale=%s" % (
            target.split("|")[-1], translate, rotate, scale))
        after = _capture_transform_state(target)
        _push_transform_history(before, after)
    except Exception as e:
        print("[RFX_MayaViewer] Transform failed for %s: %s" % (target, str(e)))
    finally:
        try:
            cmds.undoInfo(closeChunk=True)
        except Exception:
            pass

    if transform_id is not None:
        _broadcast_json_message({
            "type": "transform_ack",
            "transform_ack": transform_id,
            "object": target
        })
        print("[RFX_MayaViewer] Transform ack sent: %s" % transform_id)


def _clients_connected():
    with _CLIENTS_LOCK:
        return len(_CLIENTS) > 0


# ---------------------------------------------------------------------------
# Minimal WebSocket server (RFC 6455)
# ---------------------------------------------------------------------------

def _accept_loop():
    while not _SERVER_STOP_EVENT.is_set():
        try:
            if _SERVER_SOCKET is None:
                break
            client_sock, addr = _SERVER_SOCKET.accept()
            if _SERVER_STOP_EVENT.is_set():
                try:
                    client_sock.close()
                except Exception:
                    pass
                break
            t = threading.Thread(
                target=_handle_client,
                args=(client_sock, addr),
                daemon=True
            )
            t.start()
        except socket.timeout:
            continue
        except Exception:
            break


def _handle_client(sock, addr):
    print("[RFX_MayaViewer] Client connecting from %s:%d" % addr)
    try:
        sock.settimeout(None)  # <--- Prevent 1.0s timeout inheritance
        if _SERVER_STOP_EVENT.is_set():
            sock.close()
            return
        if not _ws_handshake(sock):
            sock.close()
            return

        with _CLIENTS_LOCK:
            if _SERVER_STOP_EVENT.is_set():
                sock.close()
                return
            _CLIENTS.append(sock)
        print("[RFX_MayaViewer] iPhone/app client connected from: %s:%d" % addr)
        _send_server_info(sock)

        # Send initial snapshot + textures
        payload = maya.utils.executeInMainThreadWithResult(_build_scene_payload)
        if payload and not _SERVER_STOP_EVENT.is_set():
            _send_scene_json(sock, json.dumps(payload))
            _send_textures_to_client(sock, payload)

        # Message loop
        while not _SERVER_STOP_EVENT.is_set():
            msg = _ws_recv(sock)
            if msg is None:
                break
            _handle_client_message(sock, msg)

    except Exception as e:
        print("[RFX_MayaViewer] Client error: %s" % str(e))
    finally:
        with _CLIENTS_LOCK:
            if sock in _CLIENTS:
                _CLIENTS.remove(sock)
        try:
            sock.close()
        except Exception:
            pass
        print("[RFX_MayaViewer] iPhone/app client disconnected from: %s:%d" % addr)


def _handle_client_message(sock, msg):
    if _SERVER_STOP_EVENT.is_set():
        return
    try:
        data = json.loads(msg)
        cmd  = data.get("command", "")
        if cmd == "snapshot":
            if _SERVER_STOP_EVENT.is_set():
                return
            print("[RFX_MayaViewer] Snapshot command received")
            payload = maya.utils.executeInMainThreadWithResult(_build_scene_payload)
            if payload and not _SERVER_STOP_EVENT.is_set():
                _send_scene_json(sock, json.dumps(payload))
                _send_textures_to_client(sock, payload)
                print("[RFX_MayaViewer] Snapshot sent to requester (%d mesh(es))" % (
                    len(payload.get("meshes", []))))
        elif cmd == "live_sync_on":
            if _SERVER_STOP_EVENT.is_set():
                return
            maya.utils.executeInMainThreadWithResult(set_live_sync, True)
        elif cmd == "live_sync_off":
            maya.utils.executeInMainThreadWithResult(set_live_sync, False)
        elif cmd == "selected_only_on":
            if _SERVER_STOP_EVENT.is_set():
                return
            set_selected_only(True)
            payload = maya.utils.executeInMainThreadWithResult(_build_scene_payload)
            if payload and not _SERVER_STOP_EVENT.is_set():
                _send_scene_json(sock, json.dumps(payload))
                _send_textures_to_client(sock, payload)
        elif cmd == "selected_only_off":
            set_selected_only(False)
            payload = maya.utils.executeInMainThreadWithResult(_build_scene_payload)
            if payload and not _SERVER_STOP_EVENT.is_set():
                _send_scene_json(sock, json.dumps(payload))
                _send_textures_to_client(sock, payload)
        elif cmd == "transform_delta":
            maya.utils.executeInMainThreadWithResult(_apply_transform_delta, data)
        elif cmd == "transform_undo":
            maya.utils.executeInMainThreadWithResult(_transform_undo)
        elif cmd == "transform_redo":
            maya.utils.executeInMainThreadWithResult(_transform_redo)
    except Exception:
        pass


def _send_server_info(sock):
    if _SERVER_STOP_EVENT.is_set():
        return
    info = {
        "type": "server_info",
        "protocol_version": _PROTOCOL_VERSION,
        "chunk_size": _WS_TEXT_CHUNK_SIZE,
        "selected_only": _SELECTED_ONLY
    }
    _ws_send(sock, json.dumps(info))


def _send_scene_json(sock, text):
    global _CHUNK_SEQ
    if _SERVER_STOP_EVENT.is_set():
        return
    if len(text.encode("utf-8")) <= _WS_TEXT_CHUNK_SIZE:
        _ws_send(sock, text)
        return

    _CHUNK_SEQ += 1
    chunk_id = "%d-%d-%d" % (int(time.time() * 1000), id(sock), _CHUNK_SEQ)
    chunks = [
        text[i:i + _WS_TEXT_CHUNK_SIZE]
        for i in range(0, len(text), _WS_TEXT_CHUNK_SIZE)
    ]

    print("[RFX_MayaViewer] Sending chunked message (%d bytes, %d chunks)" % (
        len(text.encode("utf-8")), len(chunks)))

    for index, chunk in enumerate(chunks):
        if _SERVER_STOP_EVENT.is_set():
            return
        envelope = {
            "type": "scene_chunk",
            "id": chunk_id,
            "index": index,
            "count": len(chunks),
            "data": chunk
        }
        _ws_send(sock, json.dumps(envelope))


def _broadcast_scene_json(text):
    if _SERVER_STOP_EVENT.is_set():
        return
    with _CLIENTS_LOCK:
        dead = []
        for sock in _CLIENTS:
            try:
                _send_scene_json(sock, text)
            except Exception:
                dead.append(sock)
        for sock in dead:
            _CLIENTS.remove(sock)


def _broadcast_json_message(payload):
    _broadcast_scene_json(json.dumps(payload))


# ---------------------------------------------------------------------------
# RFC 6455 WebSocket frame encoding/decoding
# ---------------------------------------------------------------------------

def _ws_handshake(sock):
    import base64
    import hashlib

    try:
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = sock.recv(1024)
            if not chunk:
                return False
            raw += chunk

        headers = {}
        lines = raw.decode("utf-8", errors="ignore").split("\r\n")
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        key = headers.get("sec-websocket-key", "")
        if not key:
            return False

        if _CONNECTION_PIN:
            request_line = lines[0] if lines else ""
            path = request_line.split(" ")[1] if len(request_line.split(" ")) > 1 else "/"
            query = {}
            if "?" in path:
                for pair in path.split("?", 1)[1].split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        query[k] = v
            if query.get("pin", "") != _CONNECTION_PIN:
                sock.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return False

        GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        accept = base64.b64encode(
            hashlib.sha1((key + GUID).encode()).digest()
        ).decode()

        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
        )
        sock.sendall(response.encode())
        return True

    except Exception as e:
        print("[RFX_MayaViewer] Handshake error: %s" % str(e))
        return False


def _ws_send(sock, text):
    if _SERVER_STOP_EVENT.is_set():
        return
    data = text.encode("utf-8")
    length = len(data)

    header = bytearray()
    header.append(0x81)  # FIN + text opcode

    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += struct.pack(">H", length)
    else:
        header.append(127)
        header += struct.pack(">Q", length)

    sock.sendall(bytes(header) + data)


def _ws_recv(sock):
    try:
        header = _recv_exact(sock, 2)
        if not header:
            return None

        opcode = header[0] & 0x0F
        masked = (header[1] & 0x80) != 0
        length = header[1] & 0x7F

        # Always decode the full frame length before checking opcode.
        # Without this, returning early for ping/close leaves the length
        # bytes, mask key, and payload in the socket buffer and corrupts
        # every subsequent read.
        if length == 126:
            ext = _recv_exact(sock, 2)
            if not ext:
                return None
            length = struct.unpack(">H", ext)[0]
        elif length == 127:
            ext = _recv_exact(sock, 8)
            if not ext:
                return None
            length = struct.unpack(">Q", ext)[0]

        mask_key = _recv_exact(sock, 4) if masked else None
        raw      = _recv_exact(sock, length)
        if raw is None:
            return None
        payload = bytearray(raw)
        if masked and mask_key:
            for i in range(length):
                payload[i] ^= mask_key[i % 4]

        if opcode == 0x8:   # close
            return None
        if opcode == 0x9:   # ping — echo application data per RFC 6455 §5.5.3
            _ws_pong(sock, bytes(payload))
            return ""
        if opcode == 0xA:   # pong — unsolicited keepalive, discard
            return ""

        return payload.decode("utf-8", errors="ignore")

    except Exception:
        return None


def _ws_pong(sock, data=b""):
    """Send a Pong frame, echoing the ping's application data (RFC 6455 §5.5.3)."""
    try:
        data = data[:125]   # pong payload ≤ 125 bytes per spec
        sock.sendall(bytes([0x8A, len(data)]) + data)
    except Exception:
        pass


def _recv_exact(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _get_local_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary_ip = s.getsockname()[0]
        s.close()
        if primary_ip and not primary_ip.startswith("127."):
            ips.append(primary_ip)
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    return ips or ["127.0.0.1"]
