module.exports = `
local count = #KEYS - 3
local day = tonumber(ARGV[1])
local captured = tonumber(ARGV[2])
for i, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  local expected = i <= count and 'zset' or 'string'
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('country_history_wrong_type') end
end
local previous = redis.call('GET', KEYS[count + 2])
if previous and tonumber(cjson.decode(previous).fetchedAt) > captured then return 0 end
for i = 1, count do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], day, day)
  redis.call('ZADD', KEYS[i], day, ARGV[4 + i])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', day - 365)
  redis.call('EXPIRE', KEYS[i], 34560000)
end
redis.call('SET', KEYS[count + 1], ARGV[3], 'EX', 34560000)
redis.call('SET', KEYS[count + 2], ARGV[4], 'EX', 34646400)
redis.call('SET', KEYS[count + 3], captured)
return count
`;
