'use strict';

/*
This example uses the router to build a virtual JSON Graph object on the server 
with the following structure:

{
    genrelist: [
        {
            name: "Thrillers",
            titles: [
                // Reference to title by identifier
                $ref('titlesById[523]'),
                $ref('titlesById[829]')
            ]
        }
    ],
    titlesById: {
        523: {
            name: "House of Cards"
        },
        829: {
            name: "Orange is the New Black"
        }
    }
}

It is hosted at a single URL (model.json) using Restify.

********** IMPORTANT ****************

It is only legal to retrieve value types from a JSON Graph 
Object. Therefore to create this virtual JSON Graph object,
_we only need to build routes that match paths along which 
value types are found_. In other words we can create this 
entire virtual JSONGraph object with only three routes.

"genrelist[{integers}].name"
"genrelist[{integers}].titles[{integers}]"
"titlesById[{integers}][{keys}]"

*************************************

As a reminder, the JSON Graph values types are:

1. null
2. string
3. boolean
4. number
5. ref - ex. { $type: "ref", value: ["titlesById", 23]}
6. atom - ex. { $type: "atom", value: 45, $expires: -233}
7. error - ex. { $type: "error", value: "The server is unavailable at the moment." }

*/ 

var Router = require('falcor-router');
var Promise = require('promise');

var jsonGraph = require('falcor-json-graph');
var $ref = jsonGraph.ref;
var $atom = jsonGraph.atom;
var $error = jsonGraph.error;

var ratingService = require('./rating-service');
var titleService = require('./title-service');
var recommendationService = require('./recommendation-service');

// A router is a collection of routes, each of which contains operation handlers 
// for the three DataSource operations (get, set, and call).
// Each route matchs a PathSet, and returns either a Promise<JSONGraphEnvelope>
// or a Promise<Array<PathValue>>.

// Routes match PathSets and returns a JSONGraphEnvelope that contains
// the subset of the JSON Graph object which contains all of the values 
// requested in the matched PathSet.

// In other words, if a route matches "genrelist[0..1].name" it could return a
// Promise that resolves to the following JSONGraphEnvelope:
// {
//    jsonGraph: {
//       genrelist: {
//          0: {
//              name: "Horror",
//          },
//          1: {
//              name: "Thrillers"
//          }
//       }
//    }
// }
// Alternately the route could resolve to the following array of PathValues:
// [
//    { path: ["genrelist", 0, "name"], value: "Horror"},
//    { path: ["genrelist", 1, "name"], value: "Thrillers"}
// ]
// When a route returns an array of PathValues, the Router mixes all of the 
// values into a single JSON Graph response anyways, producing the equivalent
// JSONGraphEnvelope.
// [
//    { path: ["genrelist", 0, "name"], value: "Horror"},
//    { path: ["genrelist", 1, "name"], value: "Thrillers"}
// ] ->
// {
//    jsonGraph: {
//       genrelist: {
//          0: {
//              name: "Horror",
//          },
//          1: {
//              name: "Thrillers"
//          }
//       }
//    }
// }
// The Router's eventual response is a JSONGraphEnvelope with the superset of
// all of the individual route JSONGraphEnvelope responses.

var NetflixRouterBase = Router.createClass([   
    {
        route: "titlesById[{integers:titleIds}].userRating",
        get: function(pathSet) {

            if (this.userId === undefined)
                throw new Error("not authorized");

            return Promise.all([
                titleService.getTitles(pathSet.titleIds),
                ratingService.getRatings(this.userId, pathSet.titleIds)
            ]).then(function(results) {
                var titles = results[0]
                var ratings = results[1]
                return pathSet.titleIds.map(function(titleId) {
                    var titleRecord = titles[titleId]
                    var ratingRecord = ratings[titleId]
                    if (titleRecord.doc == null || titleRecord.error == "not_found") {
                        return {
                            path: ['titlesById', titleId],
                            value: jsonGraph.undefined()
                        };    
                    } else if (ratingRecord.doc) {
                        return {
                            path: ['titlesById', titleId, 'userRating'], 
                            value: ratingRecord.doc.rating
                        };
                   } else if (!ratings[titleId].error || ratings[titleId].error == "not_found") {
                        return {
                            path: ['titlesById', titleId, 'userRating'],
                            value: jsonGraph.undefined()
                        };
                    } else {
                        return {
                            path: ['titlesById', titleId, 'userRating'],
                            value: $error(ratingRecord.error)
                        };
                    };

                })
            })
        },
        
        set: function (jsonGraphArg) {
    
            if (this.userId === undefined)
                throw new Error("not authorized");

            var ids = Object.keys(jsonGraphArg.titlesById);                        
            return ratingService.setRatings(this.userId, jsonGraphArg.titlesById).
                then(function(ratings) {                     
                    return ids.map(function(id) {
                        if (!ratings[id].error) {
                            return {
                                path: ['titlesById', id, 'userRating'],
                                value: ratings[id].doc.rating
                            };
                        } else {
                            return {
                                path: ['titlesById', id],
                                value: $error(ratings[id].message) 
                            };
                        }
                    });    
                });
        }
    },
        
    // Here's an example subset of the JSON Graph which this route simulates.
    // {
    //     genrelist: [
    //         {
    //             name: "Thrillers"
    //         },
    //     ]
    // }
    {
        route: "genrelist[{integers:indices}].name",
        get: function (pathSet) {
                        
            // In this example, the pathSet could be ["genrelist", [0,1,2], "name"].
            // If that were the case, we would need to return a Promise of an
            // Array containing the following PathValues: 
            // {path: ["genreList", 0, "name"], value: "Horror"}
            // {path: ["genreList", 1, "name"], value: "Thrillers"}
            // {path: ["genreList", 2, "name"], value: "New Releases"}
            return recommendationService.getGenreList(this.userId)
                .then(function(genrelist) {
                    // use the indices alias to retrieve the array (equivalent to pathSet[1])             
                    return pathSet.indices.map(function(index) {
                        // If we determine that the index does not exist, we must 
                        // return an atom of undefined. Returning nothing is _not_
                        // an acceptable response. 
                        // Note that we are also specific about what part of the
                        // JSON is null. We clearly respond that the 
                        // list is null or undefined, _not_ the name of the list.
                        var list = genrelist[index],
                            results = [];

                        if (list == null) {
                            return { path: ["genrelist", index], value: $atom(list)};
                        }

                        return {
                            path: ['genrelist', index, 'name'],
                            value: genrelist[index].name
                        };
                    });
                });
        }
    }, 
    // Here's an example subset of the JSON Graph which this route simulates.
    // {
    //     genrelist: [
    //         {
    //             titles: [
    //                  $ref('titlesById[523]')
    //             ]
    //         }
    //     ]
    // }
    {
        route: "genrelist[{integers:indices}].titles[{integers:titleIndices}]",
        get: function (pathSet) {
            return recommendationService.getGenreList(this.userId).
                then(function(genrelist) {
                   
                    var pathValues = [];
                    pathSet.indices.forEach(function (index) {
                        pathSet.titleIndices.forEach(function(titleIndex) {
                            var titleID = genrelist[index].titles[titleIndex];
                            if (titleID == null) {
                                pathValues.push({ path: ["genrelist", index, "titles", titleIndex], value: $atom(titleID) });
                            }
                            else {
                                pathValues.push({
                                    path: ['genrelist', index, 'titles', titleIndex],
                                    value: $ref(['titlesById', titleID])
                                });
                            }
                        });
                    });
                    return pathValues;
                });
        }
    }, 
    // This route simulates the following subset of the JSON Graph object.
    // {
    //     titlesById: {
    //         [{integers}]: {
    //            "title":"Blitz",
    //            "year":2011,
    //            "description":"With a serial killer on the loose in London, a detective takes on the case while working out his aggression issues with a police-appointed shrink.",
    //            "rating":1.7,
    //            "boxshot":"http://cdn.test.nflximg.net/images/9236/1919236.jpg"
    //         }
    //     }
    // }
    // Unlike the other routes which return a Promise<Array<PathValue>>, this route returns a 
    // Promise<JSONGraphEnvelope>.
    {
        route: "titlesById[{integers:titleIds}]['name','year','description','boxshot','rating']",
        get: function (pathSet) {
            
            // Unlike the other routes which return Promise<Array<PathValue>>, this route will 
            // return a Promise<JSONGraphEnvelope>.
            // For example if the matched pathSet is ["titlesById", [923,619], "year", "rating"], 
            // the JSONGraph response from the route handler might look like this:
            // {
            //    jsonGraph: {
            //        titlesById: {
            //            923: {
            //                "year": 2001,
            //                "rating": 5
            //            },
            //            619: {
            //                "year": 2013,
            //                "rating": 3
            //            }            
            //        }
            //    }
            // }

            var titleKeys = pathSet[2];
            return titleService.getTitles(pathSet.titleIds).
                then(function(titles) {
                    var response = {};
                    var jsonGraphResponse = response['jsonGraph'] = {};                    
                    var titlesById = jsonGraphResponse['titlesById'] = {};

                    pathSet.titleIds.forEach(function(titleId) {
                        var responseTitle = titles[titleId],
                            title = {};
                        if (responseTitle.error == "not_found") {
                            titlesById[titleId] = jsonGraph.undefined();
                        } else if (responseTitle.error) {
                            titlesById[titleId] = $error(responseTitle.error);
                        } else {
                            titleKeys.forEach(function(key) {
                                title[key] = responseTitle.doc[key];
                            });
                            titlesById[titleId] = title;
                        }
                    });
                    return response;
                });
            
        }
    },
    {
        route: 'genrelist.length',
        get: function(pathSet) {
               
            return recommendationService.getGenreList(this.userId)
                .then(function(genrelist) {             
                    return {
                        path: ['genrelist', 'length'],
                        value: genrelist.length
                    };
                });
        }
    },    
    {
        route: 'genrelist[{integers:indices}].titles.length',
        get: function(pathSet) {
               
            return recommendationService.getGenreList(this.userId)
                .then(function(genrelist) {             
                    return pathSet.indices.map(function(index) {
                        var list = genrelist[index];
                        
                        if (list == null) {
                            return { path: ["genrelist", index, 'titles', 'length'], value: $atom(list)};
                        }
                        return {
                            path: ['genrelist', index, 'titles', 'length'],
                            value: list.titles.length
                        };
                    });
                });
        }
    },    
    {
        route: 'genrelist[{integers:indices}].titles.remove',
        call: function(callPath, args) {
            
            if (this.userId == undefined)
                throw new Error("not authorized");

            var genreIndex = callPath.indices[0], titleIndex = args[0];

            return recommendationService.
                removeTitleFromGenreListByIndex(this.userId, genreIndex, titleIndex).
                then(function(titleIdAndLength) {
                    return [
                        {
                            path: ['genrelist', genreIndex, 'titles', {from: titleIndex, to: titleIdAndLength.length }],
                            invalidated: true
                        },
                        {
                            path: ['genrelist', genreIndex, 'titles', 'length'],
                            value: titleIdAndLength.length
                        }
                    ];
                });
        }
    },
    {
        route: 'genrelist[{integers:indices}].titles.push',
        call: function(callPath, args) {
               
            if (this.userId == undefined)
                throw new Error("not authorized");

            var titleRef = args[0], titleId, genreIndex = callPath.indices[0];
            if (titleRef == null || titleRef.$type !== "ref" || titleRef.value[0] != "titlesById" || titleRef.value.length !== 2) {
                throw new Error("invalid input");
            }
            
            titleId = titleRef.value[1];
            if (parseInt(titleId, 10).toString() !== titleId.toString())
                throw new Error("invalid input");

            return recommendationService.
                addTitleToGenreList(this.userId, genreIndex, titleId).
                then(function(length) {
                    return [
                        {
                            path: ['genrelist', genreIndex, 'titles', length - 1],
                            value: titleRef
                        },
                        {
                            path: ['genrelist', genreIndex, 'titles', 'length'],
                            value: length
                        }
                    ];
                });
        }
    }
]);


var NetflixRouter = function(userId) {
    NetflixRouterBase.call(this);
    this.userId = userId;
};
NetflixRouter.prototype = Object.create(NetflixRouterBase.prototype);

module.exports = function(userId) {
    return new NetflixRouter(userId);    
}
