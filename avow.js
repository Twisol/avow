/* Copyright (c) 2012-2013 Brian Cavalier */
(function(define, global) {
define(function() {

	var avow, nextTick, defaultConfig, bind, uncurryThis, call, apply,
		arrayProto, reduce, undef;

	bind = Function.prototype.bind;
	uncurryThis = bind.bind(bind.call);

	call = uncurryThis(bind.call);
	apply = uncurryThis(bind.apply);

	arrayProto = Array.prototype;
	reduce = uncurryThis(arrayProto.reduce);

	// Use process.nextTick or setImmediate if available, fallback to setTimeout
	nextTick = (function () {
		var globalSetTimeout = setTimeout;
		/*global setImmediate,process*/
		return typeof setImmediate === 'function'
			? setImmediate.bind(global)
			: typeof process === 'object'
				? process.nextTick
				: function(task) { globalSetTimeout(task, 0); };
	}());

	// Default configuration
	defaultConfig = {
		nextTick:  nextTick,
		unhandled: noop,
		handled:   noop,
		protect:   noop
	};

	// Create the default module instance
	// This is what you get when you require('avow')
	avow = constructAvow(defaultConfig);

	// You can use require('avow').construct(options) to
	// construct a custom configured version of avow
	avow.construct = constructAvow;

	return avow;

	// This constructs configured instances of the avow module
	function constructAvow(config) {

		var nextTick, onHandled, onUnhandled, protect;

		// Grab the config params, use defaults where necessary
		nextTick    = config.nextTick  || defaultConfig.nextTick;
		onHandled   = config.handled   || defaultConfig.handled;
		onUnhandled = config.unhandled || defaultConfig.unhandled;
		protect     = config.protect   || defaultConfig.protect;

		// Add resolve and reject methods.
		promise.lift   = lift;
		promise.reject = reject;

		promise.all    = all;
		promise.any    = any;
		promise.settle = settle;

		promise.fmap   = fmap;

		return promise;

		// Trusted promise constructor
		function Promise(then) {
			this.then = then;
			protect(this);
		}

		// Return a pending promise whose fate is determined by resolver
		function promise(resolver) {
			var self, value, handled, handlers = [];

			self = new Promise(then);

			// Call the resolver to seal the promise's fate
			try {
				resolver(promiseResolve, promiseReject);
			} catch(e) {
				promiseReject(e);
			}

			// Return the promise
			return self;

			// Register handlers with this promise
			function then(onFulfilled, onRejected) {
				if (!handled) {
					handled = true;
					onHandled(self);
				}

				return promise(function(resolve, reject) {
					handlers
						// Call handlers later, after resolution
						? handlers.push(function(value) {
							value.then(onFulfilled, onRejected).then(resolve, reject);
						})
						// Call handlers soon, but not in the current stack
						: nextTick(function() {
							value.then(onFulfilled, onRejected).then(resolve, reject);
						});
				});
			}

			// Resolve with a value, promise, or thenable
			function promiseResolve(value) {
				if(!handlers) {
					return;
				}

				resolve(lift(value));
			}

			// Reject with reason verbatim
			function promiseReject(reason) {
				if(!handlers) {
					return;
				}

				if(!handled) {
					onUnhandled(self, reason);
				}

				resolve(reject(reason));
			}

			// For all handlers, run the Promise Resolution Procedure on this promise
			function resolve(x) {
				var queue = handlers;
				handlers = undef;
				value = x;

				nextTick(function () {
					queue.forEach(function (handler) {
						handler(value);
					});
				});
			}
		}

		// Return a trusted promise for x, where
		// - if x is a Promise, return it
		// - if x is a value, return a promise that will eventually fulfill with x
		// - if x is a thenable, assimilate it and return a promise whose fate
		//   follows that of x.
		function lift(x) {
			if(x instanceof Promise) {
				return x;
			} else if (x !== Object(x)) {
				return fulfilled(x);
			}

			return promise(function(resolve, reject) {
				nextTick(function() {
					try {
						// We must check and assimilate in the same tick, but not the
						// current tick, careful only to access promiseOrValue.then once.
						var untrustedThen = x.then;

						if(typeof untrustedThen === 'function') {
							call(untrustedThen, x, resolve, reject);
						} else {
							// It's a value, create a fulfilled wrapper
							resolve(fulfilled(x));
						}
					} catch(e) {
						// Something went wrong, reject
						reject(e);
					}
				});
			});
		}

		// Return a rejected promise
		function reject(reason) {
			return new Promise(function (_, onRejected) {
				return promise(function(resolve, reject) {
					if(typeof onRejected == 'function') {
						resolve(onRejected(reason));
					} else {
						reject(reason);
					}
				});
			});
		}

		// private
		// create an already-fulfilled promise used to break assimilation recursion
		function fulfilled(x) {
			var self = new Promise(function (onFulfilled) {
				try {
					return typeof onFulfilled == 'function'
						? lift(onFulfilled(x)) : self;
				} catch (e) {
					return reject(e);
				}
			});

			return self;
		}

		// Return a promise that will fulfill after all promises in array
		// have fulfilled, or will reject after one promise in array rejects
		function all(array) {
			return lift(array).then(function(array) {
				return promise(function(resolve, reject) {
					var count = 0, results = [];

					reduce(array, function(results, p, i) {
						++count;
						lift(p).then(addResult.bind(undef, i), reject);
						return results;
					}, results);

					function addResult(index, x) {
						results[index] = x;
						if(!--count) {
							resolve(results);
						}
					}
				});
			});
		}

		// Return a promise that will fulfill after one promise in array
		// is fulfilled, or will reject after all promises in array have rejected
		function any(array) {
			return lift(array).then(function(array) {
				return promise(function(resolve, reject) {
					var count = 0, results = [];

					reduce(array, function(results, p, i) {
						++count;
						lift(p).then(resolve, addResult.bind(undef, i));
						return results;
					}, results);

					function addResult(index, x) {
						results[index] = x;
						if(!--count) {
							reject(results);
						}
					}
				});
			});
		}

		// Return a promise that will fulfill with an array of objects, each
		// with a 'value' or 'reason' property corresponding to the fulfillment
		// value or rejection reason of the
		function settle(array) {
			return lift(array).then(function(array) {
				return all(array.map(function(item) {
					return lift(item).then(toValue, toReason);
				}));
			});
		}

		// Return a function that accepts promises as arguments and
		// returns a promise.
		function fmap(f) {
			return function() {
				return all(arguments).then(apply.bind(f, undef));
			};
		}
	}

	function toValue(x) {
		return { value: x };
	}

	function toReason(x) {
		return { reason: x };
	}

	function noop() {}

});
})(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(); }, this);