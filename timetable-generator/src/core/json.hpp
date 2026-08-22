// A small, dependency-free JSON reader and writer.
//
// The solver core must build with nothing but a C++20 compiler — no Qt, no vcpkg, no network at
// configure time — because it is the part that has to run inside a benchmark harness on a machine
// that has none of those. That rules out every JSON library worth having, so this is the minimum
// that reads the benchmark's `SolverProblem` files and writes a placement list back.
//
// Deliberately narrow: it parses the subset RFC 8259 describes, keeps numbers as double, and does
// not pretend to be fast at anything but the one shape it is given. Object member lookup is linear
// because the objects here have five keys, not five hundred.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace tg {

class Json;
using JsonArray = std::vector<Json>;

class Json {
 public:
  enum class Kind : uint8_t { Null, Bool, Number, String, Array, Object };

  Json() = default;
  explicit Json(bool b) : kind_(Kind::Bool), num_(b ? 1 : 0) {}
  explicit Json(double d) : kind_(Kind::Number), num_(d) {}
  explicit Json(long long d) : kind_(Kind::Number), num_(static_cast<double>(d)) {}
  explicit Json(int d) : kind_(Kind::Number), num_(static_cast<double>(d)) {}
  explicit Json(std::string s) : kind_(Kind::String), str_(std::move(s)) {}
  explicit Json(const char* s) : kind_(Kind::String), str_(s) {}

  static Json array(JsonArray v) {
    Json j;
    j.kind_ = Kind::Array;
    j.arr_ = std::move(v);
    return j;
  }
  static Json object() {
    Json j;
    j.kind_ = Kind::Object;
    return j;
  }

  Kind kind() const { return kind_; }
  bool isNull() const { return kind_ == Kind::Null; }
  bool isArray() const { return kind_ == Kind::Array; }
  bool isObject() const { return kind_ == Kind::Object; }
  bool isString() const { return kind_ == Kind::String; }
  bool isNumber() const { return kind_ == Kind::Number; }

  bool asBool(bool dflt = false) const {
    if (kind_ == Kind::Bool) return num_ != 0;
    if (kind_ == Kind::Number) return num_ != 0;
    return dflt;
  }
  double asDouble(double dflt = 0) const { return kind_ == Kind::Number ? num_ : dflt; }
  int asInt(int dflt = 0) const {
    return kind_ == Kind::Number ? static_cast<int>(num_ < 0 ? num_ - 0.5 : num_ + 0.5) : dflt;
  }
  const std::string& asString() const {
    static const std::string kEmpty;
    return kind_ == Kind::String ? str_ : kEmpty;
  }

  const JsonArray& items() const {
    static const JsonArray kEmpty;
    return kind_ == Kind::Array ? arr_ : kEmpty;
  }
  size_t size() const { return kind_ == Kind::Array ? arr_.size() : (kind_ == Kind::Object ? obj_.size() : 0); }

  // Array element. Out-of-range reads as null rather than throwing: the callers here are readers
  // of external data and every one of them has a sane default.
  const Json& operator[](size_t i) const {
    static const Json kNull;
    return (kind_ == Kind::Array && i < arr_.size()) ? arr_[i] : kNull;
  }

  // Object member, null when absent.
  const Json& operator[](std::string_view key) const {
    static const Json kNull;
    if (kind_ != Kind::Object) return kNull;
    auto it = obj_.find(std::string(key));
    return it == obj_.end() ? kNull : it->second;
  }
  bool has(std::string_view key) const {
    return kind_ == Kind::Object && obj_.count(std::string(key)) != 0;
  }

  void set(std::string key, Json value) {
    kind_ = Kind::Object;
    obj_.insert_or_assign(std::move(key), std::move(value));
  }
  void push(Json value) {
    kind_ = Kind::Array;
    arr_.push_back(std::move(value));
  }

  const std::map<std::string, Json>& members() const {
    static const std::map<std::string, Json> kEmpty;
    return kind_ == Kind::Object ? obj_ : kEmpty;
  }

  static Json parse(std::string_view text);
  // Reads a file, transparently gunzipping it when the name ends in `.gz` (via popen'd gzip, which
  // is present everywhere this runs and saves a zlib dependency the core otherwise does not need).
  static Json parseFile(const std::string& path);

  std::string dump(int indent = -1) const;

 private:
  void dumpTo(std::string& out, int indent, int depth) const;

  Kind kind_ = Kind::Null;
  double num_ = 0;
  std::string str_;
  JsonArray arr_;
  std::map<std::string, Json> obj_;
};

std::string readFileText(const std::string& path);

}  // namespace tg
