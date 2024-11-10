
printjson(db.areas.createIndex({ parent: 1 }))
printjson(db.areas.createIndex({ 'embeddedRelations.ancestorIndex': 1 }))
printjson(db.areas.createIndex({ 'embeddedRelations.children': 1 }))

//  https://www.mongodb.com/docs/v6.2/reference/method/db.collection.createIndex/#create-an-index-on-a-multiple-fields
//  > The order of fields in a compound index is important for supporting sort() operations using the index.

// It is not clear to me if there is a $lookup speed implication based on the direction of the join.
printjson(db.areas.createIndex({ parent: 1, _id: 1 }))
