#include "json.hpp"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>

namespace tg {
namespace {

struct Parser {
  std::string_view s;
  size_t i = 0;

  [[noreturn]] void fail(const char* what) const {
    throw std::runtime_error("JSON: " + std::string(what) + " at offset " + std::to_string(i));
  }

  void ws() {
    while (i < s.size()) {
      const char c = s[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { ++i; continue; }
      break;
    }
  }

  bool literal(std::string_view lit) {
    if (s.size() - i < lit.size()) return false;
    if (s.compare(i, lit.size(), lit) != 0) return false;
    i += lit.size();
    return true;
  }

  static void appendUtf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  uint32_t hex4() {
    if (i + 4 > s.size()) fail("truncated \\u escape");
    uint32_t v = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = s[i + k];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<uint32_t>(c - 'A' + 10);
      else fail("bad hex digit in \\u escape");
    }
    i += 4;
    return v;
  }

  std::string str() {
    if (i >= s.size() || s[i] != '"') fail("expected string");
    ++i;
    std::string out;
    while (true) {
      if (i >= s.size()) fail("unterminated string");
      const char c = s[i++];
      if (c == '"') break;
      if (c != '\\') { out.push_back(c); continue; }
      if (i >= s.size()) fail("unterminated escape");
      const char e = s[i++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          uint32_t cp = hex4();
          // A surrogate pair is two \u escapes; anything else is passed through as-is, which is
          // what every lenient reader does and is harmless for the data this reads.
          if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
            const size_t save = i;
            i += 2;
            const uint32_t lo = hex4();
            if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            else i = save;
          }
          appendUtf8(out, cp);
          break;
        }
        default: fail("unknown escape");
      }
    }
    return out;
  }

  Json value() {
    ws();
    if (i >= s.size()) fail("unexpected end of input");
    switch (s[i]) {
      case 'n':
        if (!literal("null")) fail("expected null");
        return Json{};
      case 't':
        if (!literal("true")) fail("expected true");
        return Json{true};
      case 'f':
        if (!literal("false")) fail("expected false");
        return Json{false};
      case '"':
        return Json{str()};
      case '[': {
        ++i;
        Json out = Json::array({});
        ws();
        if (i < s.size() && s[i] == ']') { ++i; return out; }
        while (true) {
          out.push(value());
          ws();
          if (i >= s.size()) fail("unterminated array");
          if (s[i] == ',') { ++i; continue; }
          if (s[i] == ']') { ++i; break; }
          fail("expected , or ] in array");
        }
        return out;
      }
      case '{': {
        ++i;
        Json out = Json::object();
        ws();
        if (i < s.size() && s[i] == '}') { ++i; return out; }
        while (true) {
          ws();
          std::string key = str();
          ws();
          if (i >= s.size() || s[i] != ':') fail("expected : in object");
          ++i;
          out.set(std::move(key), value());
          ws();
          if (i >= s.size()) fail("unterminated object");
          if (s[i] == ',') { ++i; continue; }
          if (s[i] == '}') { ++i; break; }
          fail("expected , or } in object");
        }
        return out;
      }
      default: {
        const size_t start = i;
        if (s[i] == '-' || s[i] == '+') ++i;
        while (i < s.size() && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' ||
                                s[i] == 'E' || s[i] == '-' || s[i] == '+')) {
          ++i;
        }
        if (i == start) fail("unexpected character");
        return Json{std::strtod(std::string(s.substr(start, i - start)).c_str(), nullptr)};
      }
    }
  }
};

void escapeInto(std::string& out, const std::string& in) {
  out.push_back('"');
  for (unsigned char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

void numberInto(std::string& out, double v) {
  // Integers print without a fractional part so a placement file diffs cleanly against the
  // JavaScript harness's output.
  if (v == static_cast<double>(static_cast<long long>(v)) && v > -1e15 && v < 1e15) {
    out += std::to_string(static_cast<long long>(v));
    return;
  }
  char buf[40];
  std::snprintf(buf, sizeof buf, "%.17g", v);
  out += buf;
}

}  // namespace

Json Json::parse(std::string_view text) {
  Parser p{text, 0};
  Json v = p.value();
  p.ws();
  return v;
}

void Json::dumpTo(std::string& out, int indent, int depth) const {
  const auto nl = [&](int d) {
    if (indent < 0) return;
    out.push_back('\n');
    out.append(static_cast<size_t>(indent * d), ' ');
  };
  switch (kind_) {
    case Kind::Null: out += "null"; return;
    case Kind::Bool: out += (num_ != 0 ? "true" : "false"); return;
    case Kind::Number: numberInto(out, num_); return;
    case Kind::String: escapeInto(out, str_); return;
    case Kind::Array: {
      if (arr_.empty()) { out += "[]"; return; }
      out.push_back('[');
      bool first = true;
      for (const auto& e : arr_) {
        if (!first) out.push_back(',');
        first = false;
        nl(depth + 1);
        e.dumpTo(out, indent, depth + 1);
      }
      nl(depth);
      out.push_back(']');
      return;
    }
    case Kind::Object: {
      if (obj_.empty()) { out += "{}"; return; }
      out.push_back('{');
      bool first = true;
      for (const auto& [k, v] : obj_) {
        if (!first) out.push_back(',');
        first = false;
        nl(depth + 1);
        escapeInto(out, k);
        out.push_back(':');
        if (indent >= 0) out.push_back(' ');
        v.dumpTo(out, indent, depth + 1);
      }
      nl(depth);
      out.push_back('}');
      return;
    }
  }
}

std::string Json::dump(int indent) const {
  std::string out;
  out.reserve(1024);
  dumpTo(out, indent, 0);
  return out;
}

std::string readFileText(const std::string& path) {
  const bool gz = path.size() > 3 && path.compare(path.size() - 3, 3, ".gz") == 0;
  std::string out;
  if (gz) {
    const std::string cmd = "gzip -dc '" + path + "'";
    FILE* f = popen(cmd.c_str(), "r");
    if (!f) throw std::runtime_error("cannot run gzip for " + path);
    std::array<char, 1 << 16> buf{};
    size_t n = 0;
    while ((n = std::fread(buf.data(), 1, buf.size(), f)) > 0) out.append(buf.data(), n);
    const int rc = pclose(f);
    if (rc != 0) throw std::runtime_error("gzip failed for " + path);
    return out;
  }
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open " + path);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

Json Json::parseFile(const std::string& path) { return Json::parse(readFileText(path)); }

}  // namespace tg
