// For each document that has children, we want to tell its children to back-link to us.
db.areas
  .find({ children: { $exists: true, $type: "array" } })
  .forEach((parentDoc) =>
    db.areas.updateMany(
      { _id: { $in: parentDoc.children } },
      { $set: { parent: parentDoc._id } },
    ),
  );

// Pre-fetch children for all documents to avoid querying in the loop
const allChildren = db.areas.aggregate([
  { $match: { parent: { $exists: true } } },
  { $group: { _id: "$parent", children: { $push: "$_id" } } }
]).toArray();

// hold a reference to the children in memory
const childrenMap = allChildren.reduce((map, item) => {
  map[item._id] = item.children;
  return map;
}, {});

// This stage will take a WHILE
db.areas.find().forEach((doc) => {
  // Perform a $graphLookup aggregation to get the full ancestor path for our target
  const pathDocs = db.areas.aggregate([
    {
      $match: { _id: doc._id },
    },
    {
      $graphLookup: {
        from: "areas",
        startWith: "$parent",
        connectFromField: "parent",
        connectToField: "_id",
        as: "ancestorPath",
        depthField: "depth",
      },
    },
    {
      $unwind: "$ancestorPath",
    },
    {
      $sort: { "ancestorPath.depth": -1 },
    },
    {
      $group: {
        _id: "$_id",
        pathTokens: { $push: "$ancestorPath.area_name" },
        ancestors: { $push: "$ancestorPath.metadata.area_id" },
        ancestorIndex: { $push: "$ancestorPath._id" },
      },
    },
  ]).toArray();

  const pathTokens = [...(pathDocs[0]?.pathTokens ?? []), doc.area_name];
  const ancestors = [
    ...(pathDocs[0]?.ancestors ?? []),
    doc.metadata.area_id,
  ].join(",");
  const ancestorIndex = pathDocs[0]?.ancestorIndex ?? [];

  const embeddedRelations = {
    children: childrenMap[doc._id] || [],
    pathTokens,
    ancestors,
    ancestorIndex,
  };

  if (pathTokens.join(",") !== doc.pathTokens.join(",")) {
    throw `Path tokens did not match (${pathTokens} != ${doc.pathTokens})`;
  }

  if (ancestors !== doc.ancestors) {
    throw `Path tokens did not match (${ancestors} != ${doc.ancestors})`;
  }

  if (ancestorIndex.length !== pathTokens.length - 1) {
    print({ ancestorIndex, pathTokens });
    throw "ancestorIndex is the wrong shape";
  }

  // Use bulkWrite for efficient updates
  db.areas.updateOne(
    { _id: doc._id },
    { $set: { embeddedRelations } }
  );
});

print("Removing old fields.");

// Remove the unneeded values since all ops have run without raising an assertion issue
db.areas.updateMany({}, {
  $unset: { children: "", pathTokens: "", ancestors: "" },
});