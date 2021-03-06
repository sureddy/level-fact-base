var _ = require('lodash');
var λ = require('contra');
var q = require('./q');
var test = require('tape');
var level = require('levelup');
var memdown = require('memdown');
var HashIndex = require('level-hash-index');
var Transactor = require('./transactor');
var genRandomString = require('./utils/genRandomString');

test("ensure schema is loaded on transactor startup", function(t){
  var db = level(memdown);

  Transactor(db, {}, function(err, transactor1){
    if(err) return t.end(err);

    transactor1.transact([
      ["sky", "color", "blue"]
    ], {}, function(err){
      t.ok(err);
      t.equals(err.toString(), "Error: Attribute not found: color");

      transactor1.transact([
        ["01", "_db/attribute", "color"],
        ["01", "_db/type"     , "String"]
      ], {}, function(err){
        if(err) return t.end(err);

        Transactor(db, {}, function(err, transactor2){
          if(err) return t.end(err);
          transactor2.transact([
            ["sky", "color", "blue"]
          ], {}, function(err){
            t.end(err);
          });
        });
      });
    });
  });
});

test("ensure schema is updated as facts are recorded", function(t){
  var db = level(memdown);

  Transactor(db, {}, function(err, transactor){
    if(err) return t.end(err);

    transactor.transact([
      ["sky", "color", "blue"]
    ], {}, function(err){
      t.ok(err);
      t.equals(err.toString(), "Error: Attribute not found: color");

      transactor.transact([
        ["01", "_db/attribute", "color"],
        ["01", "_db/type"     , "String"]
      ], {}, function(err){
        if(err) return t.end(err);

        transactor.transact([
          ["sky", "color", "blue"]
        ], {}, function(err){
          t.end(err);
        });
      });
    });
  });
});

test("ensure transact persists stuff to the db", function(t){
  var db = level(memdown);

  Transactor(db, {}, function(err, transactor){
    if(err) return t.end(err);

    λ.series([
      λ.curry(transactor.transact, [
        ["01", "_db/attribute", "name"],
        ["01", "_db/type"     , "String"],
        ["02", "_db/attribute", "age"],
        ["02", "_db/type"     , "Integer"],
        ["03", "_db/attribute", "user_id"],
        ["03", "_db/type"     , "Entity_ID"]
      ], {}),
      λ.curry(transactor.transact, [
        ["0001", "name", "bob"],
        ["0001", "age",   34],
        ["0002", "name", "jim"],
        ["0002", "age",   23]
      ], {user_id: "0001"})
    ], function(err){
      if(err) return t.end(err);

      var all_data = [];
      db.readStream().on('data', function(data){
        all_data.push(data);
      }).on('close', function(){
        t.equals(all_data.length, 74);
        t.end();
      });
    });
  });
});

test("ensure transactor warms up with the latest transaction id", function(t){
  var db = level(memdown);

  Transactor(db, {}, function(err, transactor){
    if(err) return t.end(err);

    λ.series([
      λ.curry(transactor.transact, [
        ["01", "_db/attribute", "is"],
        ["01", "_db/type"     , "String"],
      ], {}),
      λ.curry(transactor.transact, [["bob", "is", "cool"]], {}),
      λ.curry(transactor.transact, [["bob", "is", "NOT cool"]], {}),
      λ.curry(transactor.transact, [["bob", "is", "cool"]], {})
    ], function(err){
      if(err) return t.end(err);

      var fb = transactor.connection.snap();
      q(fb, [["?_", "?_", "?_", "?txn"]], [{}], function(err, results){
        if(err) return t.end(err);

        var txns = _.unique(_.pluck(results, "?txn")).sort();
        t.deepEqual(txns, [1, 2, 3, 4]);

        //warm up a new transactor to see where it picks up
        Transactor(db, {}, function(err, transactor2){
          if(err) return t.end(err);

          transactor2.transact([["bob", "is", "NOT cool"]], {}, function(err, fb2){
            if(err) return t.end(err);

            q(fb2, [["?_", "?_", "?_", "?txn"]], [{}], function(err, results){
              var txns = _.unique(_.pluck(results, "?txn")).sort();
              t.deepEqual(txns, [1, 2, 3, 4, 5]);
              t.end(err);
            });
          });
        });
      });
    });
  });
});

test("transactions must be done serially, in the order they are recieved", function(t){
  var db = level(memdown);

  Transactor(db, {}, function(err, transactor){
    if(err) return t.end(err);

    var transact_attr = function(attr_name){
      return function(callback){
        transactor.transact([
          ["01", "_db/attribute", attr_name],
          ["01", "_db/type"     , "String"]
        ], {}, function(err, fb){
          callback(null, err ? "fail" : fb.txn);
        });
      };
    };
    λ.concurrent([
      transact_attr("works"),
      transact_attr(111),//fails
      transact_attr("also works")
    ], function(err, results){
      if(err) return t.end(err);
      t.deepEquals(results, [1, 'fail', 2]);
      t.end();
    });
  });
});

var setUpRetractTest = function(multiValued, callback){
  var db = level(memdown);
  Transactor(db, {}, function(err, transactor){
    if(err) return callback(err);

    λ.series([
      λ.curry(transactor.transact, [["1", "_db/attribute", "email"],
                                    ["1", "_db/type"     , "String"],
                                    ["1", "_db/is-multi-valued", multiValued]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@1"]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@2"]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@2", false]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@3"]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@2"]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@1", false]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@2", false]], {}),
      λ.curry(transactor.transact, [["bob", "email", "email@3", false]], {})
    ], function(err, fbs){
      if(err) return callback(err);

      λ.map.series(fbs, function(fb, callback){
        q(fb, [['bob', 'email', '?email']], [{}], function(err, results){
          callback(err, _.pluck(results, '?email').sort());
        });
      }, callback);
    });
  });
};

test("retracting facts", function(t){
  setUpRetractTest(false, function(err, emails_over_time){
    if(err) return t.end(err);

    t.deepEquals(emails_over_time, [
        [],
        ['email@1'],
        ['email@2'],
        [],
        ['email@3'],
        ['email@2'],
        [],
        [],
        []
    ]);
    t.end();
  });
});

test("retracting multi-valued facts", function(t){
  setUpRetractTest(true, function(err, emails_over_time){
    if(err) return t.end(err);

    t.deepEquals(emails_over_time, [
        [],
        ['email@1'],
        ['email@1', 'email@2'],
        ['email@1'],
        ['email@1', 'email@3'],
        ['email@1', 'email@2', 'email@3'],
        ['email@2', 'email@3'],
        ['email@3'],
        []
    ]);
    t.end();
  });
});
