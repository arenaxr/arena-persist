# Arena Persistence service

Listens on MQTT for ARENA objects to save to mongodb store.

A client then can make an HTTP request to the URL the server this service is running on the retrieve a list of
persisted objects to load upon entering any scene.

## Documentation
- [Requirements & Architecture](REQUIREMENTS.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Install

- Install nodejs
- `npm install`

## Updating Mongodb
Note that updating major versions of mongodb will require setting the appropriate compatibility version
per [documentation](https://www.mongodb.com/docs/manual/release-notes/8.0-upgrade-standalone/#prerequisites)

### Indexes that must be dropped by hand

Mongoose only ever *creates* indexes; removing an index from the schema never drops it from a
database that already has it. A database created before these indexes were removed from the schema
keeps them, and keeps paying to maintain them on every write. Once per deployment:

```
db.arenaobjects.dropIndex('object_id_1')
db.arenaobjects.dropIndex('namespace_1')
db.arenaobjects.dropIndex('sceneId_1')
```

Each is redundant against the compound indexes `{namespace, sceneId, attributes.parent}` and
`{namespace, sceneId, object_id}`, and leaving them in place also leaves the query planner a
candidate whose bounds span a whole namespace or a whole scene name.

`ArenaObject.syncIndexes()` reconciles the collection with the schema in one call and drops the same
three. Either form takes a brief exclusive lock on the collection, so neither belongs in application
startup.

## Usage

### Persistence

- An ARENA object is added to persist if it has `action: create` and  `persist: true`  in its MQTT message.
  - If the object already exists in persist, its `data` will be **replaced** in entirety. Fields the create message
    does not carry, such as an `expireAt` from an earlier `ttl`, are left as they are: the write is an upsert that
    mongoose casts to `$set`, so it merges at the document level.
- A persisted ARENA object can be updated if it has `action: update`  and `persist: true` set in its MQTT message. The
   properties in its `data` will be merged on top of the previously saved `data`.
    - If an `update` message contains an explicit `overwrite: true`, then the `data` therein will **replace** what is saved in persistence.
    - If an `update` message contains an explicit `persist: false`, then the `data` therein will not be updated to persistence.

### TTL
Adding a `ttl` (float seconds) to the top level MQTT message for any `create` action signals that the object
will be automatically deleted from peristence after set duration, as well as a corresponding `delete` action message
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
