# Arena Persistence service

Listens on MQTT for ARENA objects to save to mongodb store.

A client then can make an HTTP request to the URL the server this service is running on the retrieve a list of
persisted objects to load upon entering any scene.


## Install

- Install nodejs
- `npm install`

## Usage

### Persistence

- An ARENA object is added to persist if it has `action: create` and  `persist: true`  in its MQTT message.
  - If the object already exists in persist, it will be **replaced** in entirety.
- A persisted ARENA object can be updated if it has `action: update`  and `persist: true` set in its MQTT message. The
   properties in its `data` will be merged on top of the previously saved `data`.
    - If an `update` message contains an explicit `overwrite: true`, then the `data` therein will **replace** what is saved in persistence.
    - If an `update` message contains an explicit `persist: false`, then the `data` therein will not be updated to persistence.

### TTL
Adding a `ttl` (float seconds) to the top level MQTT message for any `create` action signals that the object
will be automatically deleted from peristence after set duration, as well as a correspdoning `delete` action message
sent over pubsub. `ttl` implies that `persist` is `true`.

### Templates

Any scene can be loaded as a **template** into another scene. This effectively clones all objects from the
source scene into the destination scene.

When a template is loaded, a parent container is first created in the target scene. This parent container follows the
object id naming scheme: `templateNamespace|templateSceneId::instanceId`, e.g. `public|lobby::instance_0`.

Then every object inside the designated @template scene is replicated as descendents of the parent container. In this
way, the parent can be repositioned, rotated, or scaled to adjust the template all at once.  The objects within
the template follow the naming scheme `templateNamespace|templateSceneId::instanceId::objectId`, e.g. `public|lobby::instance_0::cube1`.

To clone an instance of a scene, send a POST request to `/persist/:targetNamespace/:targetSceneId` with JSON payload:

```
{
  action: "clone",
  namespace: <string>,     // name of source scene namespace
  sceneId: <string>,       // name of source scene sceneId
  allowNonEmptyTarget: <bool>,   // (optional) - set to `true` allow templating into a non-empty destination scene
}
```

After the template load, all objects behave as typical in any scene.

*Notes:*

- If a template source scene is empty with no objects, or the instanceid already exists within a target scene, the template
load will fail.
