var EventEmitter = require('events')
var HyperList = null // require() can't handle circular deps so we resolve this lazily

module.exports = class HyperMap extends EventEmitter {
  constructor (opts) {
    super()
    if (HyperList === null) {
      HyperList = require('./list')
    }
    this.onerror = this.onerror.bind(this)
    this.onchange = this.onchange.bind(this)
    this.key = opts.key
    this._prefix = opts.prefix || ''
    this.prefix = opts.prefix ? (opts.prefix + '/') : ''
    this.root = opts.root || this
    this.parent = opts.parent
    this.storage = opts.storage
    this._links = opts.link
    this.embedded = opts.embedded
    this.debounce = opts.debounce === undefined ? 25 : opts.debounce
    this.children = {}
    this._autoWatch = setTimeout(() => this.watch())
  }

  get loading () {
    if (this.data === undefined) return true
    for (var key in this.children) {
      var child = this.children[key]
      if (child.loading) return true
    }
    return false
  }

  get loaded () {
    return !this.loading
  }

  get notFound () {
    return !this.loading && this.data === null
  }

  get link () {
    return this._links
  }

  set link (links) {
    this._links = links
    this.update()
  }

  watch () {
    delete this.data
    if (this.embedded) {
      this.update()
      return
    }
    this.storage.watch(this, err => {
      err.target = this
      this.data = null
      this.emit('error', err)
      this.update()
    })
  }

  unwatch () {
    clearTimeout(this._autoWatch)
    this.storage.unwatch(this)
    delete this.dataByKey
    delete this.parentData
    for (var key in this.children) {
      var child = this.children[key]
      child.removeListener('error', this.onerror)
      child.removeListener('change', this.onchange)
      child.unwatch()
      delete child.root
      delete child.parent
    }
    this.children = {}
  }

  acquireData (force) {
    if (!this.embedded) return true
    var parentIsList = this.parent.type === 'list'
    var parentData = parentIsList ? this.parent.dataByKey : this.parent.data
    if (parentData === undefined) return
    if (parentData) parentData = parentIsList ? parentData[this.key].data : parentData[this.key]
    if (!force && parentData === this.parentData) return
    this.data = this.parentData = parentData
    delete this.cache
    return true
  }

  update (force = true) {
    if (!this.acquireData(force)) return
    if (this.loading) return
    var hash = JSON.stringify(this.data)
    var changed = hash !== this.hash
    this.hash = hash
    var links = {}
    this.forEachLink(this._links, this.data, (location, property, childKey, opts) => {
      links[childKey] = [ opts, location[property] ]
    })
    for (var childKey in this.children) {
      var child = this.children[childKey]
      var link = links[childKey]
      if (link) {
        var foreignKey = link[1]
        if (foreignKey === child.key || typeof foreignKey === 'object') {
          if (child._each) {
            var childEach = link[0].each
            if (child._each !== childEach) {
              child.each = childEach
            }
          } else {
            var childLink = link[0].link
            if (child.link !== childLink) {
              child.link = childLink
            }
          }
          continue
        }
      }
      changed = true
      child.removeListener('error', this.onerror)
      child.removeListener('change', this.onchange)
      child.unwatch()
      delete child.root
      delete child.parent
      delete this.children[childKey]
    }
    for (childKey in links) {
      child = this.children[childKey]
      if (child) {
        if (child.embedded) {
          child.update(false)
        }
        continue
      }
      changed = true
      link = links[childKey]
      var opts = Object.assign({}, link[0])
      var key = link[1]
      var prefix = this._prefix
      var embedded = false
      var Klass = HyperMap
      if (key === undefined) {
        key = opts.key
        key = opts.key = typeof key === 'function' ? key(this) : key
      }
      if (key === undefined) continue
      if (typeof opts.prefix === 'function') {
        opts.prefix = opts.prefix(this)
      }
      if (opts.type === 'list') {
        if (typeof key === 'object') {
          key = opts.key = childKey
          embedded = true
          if (opts.prefix === undefined) {
            prefix = this.prefix + this.key
          }
        }
        Klass = HyperList
      }
      child = this.children[childKey] = new Klass(Object.assign({
        key,
        prefix,
        embedded,
        root: this.root,
        parent: this,
        storage: this.storage,
        debounce: 0
      }, opts))
      child.on('error', this.onerror)
      child.on('change', this.onchange)
    }
    if (changed) {
      this.onchange()
    }
  }

  forEachLink (links, data, cb) {
    for (var path in links) {
      var opts = links[path]
      if (typeof opts !== 'object') opts = {}
      var pointers = [[ data, '' ]]
      var components = path.split('/')
      var wildComponent = 0
      components.forEach((component, i) => {
        var last = i === components.length - 1
        var nextPointers = []
        pointers.forEach(pointer => {
          var location = pointer[0]
          if (!location || typeof location !== 'object') return
          var relpath = pointer[1]
          if (relpath) relpath += '/'
          var property = null
          if (component === '*') {
            var filters = opts.wild
              ? opts.wild[wildComponent]
              : null
            if (filters) {
              for (var n = 0; n < filters.length; n++) {
                var filter = filters[n]
                var isString = typeof filter === 'string'
                for (var p in location) {
                  if (location[p] === undefined) continue
                  if (isString) {
                    if (p === filter) {
                      property = p
                      break
                    }
                  } else {
                    if (filter.test(p)) {
                      property = p
                      break
                    }
                  }
                }
                if (property) break
              }
              if (!property) return
              if (last) {
                cb(location, property, relpath + property, opts)
              } else {
                nextPointers.push([
                  location[property],
                  relpath + property
                ])
              }
            } else {
              for (property in location) {
                if (location[property] === undefined) continue
                if (last) {
                  cb(location, property, relpath + property, opts)
                } else {
                  nextPointers.push([
                    location[property],
                    relpath + property
                  ])
                }
              }
            }
          } else {
            property = component
            var hasValue = location[property] !== undefined
            if (last && (hasValue || opts.key !== undefined)) {
              cb(location, property, relpath + property, opts)
            } else if (hasValue) {
              nextPointers.push([
                location[property],
                relpath + property
              ])
            }
          }
        })
        if (component === '*') {
          wildComponent++
        }
        pointers = nextPointers
      })
    }
  }

  denormalize (cacheBehavior = 1) {
    var data = this.cache
    if (!cacheBehavior || !data) {
      if (this.data === null) {
        data = null
      } else {
        data = this.data ? JSON.parse(this.hash) : {}
        var key = this.key
        Object.defineProperty(data, 'key', {
          enumerable: false,
          get: () => key
        })
      }
      this.cache = data
    } else if (cacheBehavior === 1 && data) {
      return data
    }
    this.forEachLink(this._links, data, (location, property, childKey, opts) => {
      var child = this.children[childKey]
      if (child) {
        location[property] = child.denormalize(cacheBehavior)
      }
    })
    return data
  }

  delete (links) {
    if (this.loading) throw new Error('cannot delete items that have not loaded')
    var patch = this.storage.delete(this)
    this.forEachLink(links || this._links, this.data, (location, property, childKey, opts) => {
      Object.assign(
        patch,
        this.children[childKey].delete()
      )
    })
    return patch
  }

  onerror (err) {
    err.currentTarget = this
    this.emit('error', err)
  }

  onchange (evt = {}) {
    if (!evt.target) evt.target = this
    delete this.cache
    if (this.debounce) {
      clearTimeout(this._debounce)
      this._debounce = setTimeout(() => {
        this.emit('change', evt || this)
      }, this.debounce)
    } else {
      this.emit('change', evt || this)
    }
  }
}
