# Portal Dataset Testing Scripts

## test-all-datasets-timestamps.sh

Comprehensive test script that queries all Portal datasets to verify block and timestamp retrieval.

### Features

- ✅ Tests all 200+ Portal datasets automatically
- ✅ Detects chain type (EVM, Solana, Substrate)
- ✅ Retrieves head block and timestamp for each chain
- ✅ Tests `/timestamps/` endpoint support
- ✅ Multiple output formats (table, JSON, CSV)
- ✅ Progress indicator
- ✅ Detailed error reporting
- ✅ Saves results to JSON file

### Usage

```bash
# Run with default table output
./scripts/test-all-datasets-timestamps.sh

# Output as JSON
./scripts/test-all-datasets-timestamps.sh json

# Output as CSV
./scripts/test-all-datasets-timestamps.sh csv

# Redirect to file
./scripts/test-all-datasets-timestamps.sh table > results.txt
```

### Output Formats

#### Table (Default)
Human-readable table with summary statistics:
```
================================================================================================
PORTAL DATASET TIMESTAMP TEST RESULTS
================================================================================================

✅ Success: 194
❌ Failed: 18
Total: 212

================================================================================================

BY CHAIN TYPE:
  evm: 180 datasets
  solana: 2 datasets
  substrate-or-other: 30 datasets

TIMESTAMP ENDPOINT SUPPORT:
  ✅ Works: 194
  ❌ Fails: 14
  N/A: 4

================================================================================================

DETAILED RESULTS:

Dataset                                  Type            Head Block      Timestamp                Endpoint
-------                                  ----            ----------      ---------                --------
base-mainnet                             evm             41814499        1770418345               ✅
ethereum-mainnet                         evm             24400886        1770418343               ❌
polygon-mainnet                          evm             82649162        1770418347               ✅
...
```

#### JSON
Complete structured data:
```json
[
  {
    "dataset": "base-mainnet",
    "head_block": 41814499,
    "head_hash": "0x...",
    "head_available": true,
    "chain_type": "evm",
    "timestamp": 1770418345,
    "block_hash": "0x...",
    "timestamp_available": true,
    "timestamp_endpoint_works": true,
    "timestamp_endpoint_1h_block": 41812699,
    "timestamp_human": "2026-02-06 23:59:05 UTC",
    "status": "success"
  },
  ...
]
```

#### CSV
Spreadsheet-compatible format:
```csv
dataset,chain_type,head_block,timestamp,timestamp_human,timestamp_endpoint_works,status
base-mainnet,evm,41814499,1770418345,2026-02-06 23:59:05 UTC,true,success
ethereum-mainnet,evm,24400886,1770418343,2026-02-06 23:59:03 UTC,false,success
...
```

### What It Tests

For each dataset:
1. **Head Block**: Queries `/datasets/{dataset}/head`
2. **Timestamp Retrieval**:
   - Tries EVM query first (`type: "evm"`)
   - Falls back to Solana query if needed (`type: "solana"`)
   - Identifies Substrate chains
3. **Timestamp Endpoint**: Tests `/timestamps/{ts-1h}/block` to check support
4. **Human Readable Time**: Converts Unix timestamp to readable format

### Output Files

Results are automatically saved to:
```
/tmp/portal_dataset_timestamps_YYYYMMDD_HHMMSS.json
```

Example:
```
/tmp/portal_dataset_timestamps_20260206_235905.json
```

### Requirements

- `curl` - HTTP requests
- `jq` - JSON processing
- `bash` 4.0+ - Script execution

### Performance

- **Full test**: ~2-5 minutes for all 212 datasets
- **Per dataset**: ~0.5-1 second
- **Parallel execution**: Not recommended (rate limiting)

### Error Handling

The script handles:
- ✅ Unknown datasets
- ✅ Head block retrieval failures
- ✅ Timestamp query failures
- ✅ Network timeouts
- ✅ Invalid JSON responses
- ✅ Mixed chain types (EVM/Solana/Substrate)

### Example Output Summary

```
================================================================================================
PORTAL DATASET TIMESTAMP TEST RESULTS
================================================================================================

✅ Success: 194
❌ Failed: 18
Total: 212

================================================================================================

BY CHAIN TYPE:
  evm: 180 datasets
  solana: 2 datasets
  substrate-or-other: 30 datasets

TIMESTAMP ENDPOINT SUPPORT:
  ✅ Works: 194
  ❌ Fails: 14
  N/A: 4
```

### Use Cases

1. **Verify Portal Infrastructure**: Check that all datasets are accessible
2. **Test Timestamp Support**: Identify which chains support `/timestamps/` endpoint
3. **Chain Type Detection**: Categorize datasets by type (EVM/Solana/Substrate)
4. **Data Export**: Generate CSV for analysis in spreadsheets
5. **CI/CD Integration**: Automated testing in pipelines
6. **Documentation**: Generate up-to-date chain support lists

### Integration Examples

#### CI/CD Pipeline
```yaml
- name: Test Portal Datasets
  run: |
    ./scripts/test-all-datasets-timestamps.sh json > results.json
    if [ $(jq '[.[] | select(.status == "failed")] | length' results.json) -gt 20 ]; then
      echo "Too many failures!"
      exit 1
    fi
```

#### Data Analysis
```bash
# Export to CSV and analyze in Python/Excel
./scripts/test-all-datasets-timestamps.sh csv > datasets.csv

# Extract only failed datasets
./scripts/test-all-datasets-timestamps.sh json | \
  jq '.[] | select(.status == "failed") | .dataset'

# Count by chain type
./scripts/test-all-datasets-timestamps.sh json | \
  jq 'group_by(.chain_type) | map({type: .[0].chain_type, count: length})'
```

### Troubleshooting

**Issue**: Script hangs on a dataset
- **Solution**: Dataset might be slow to respond, wait or skip it

**Issue**: `jq: command not found`
- **Solution**: Install jq: `brew install jq` (macOS) or `apt-get install jq` (Linux)

**Issue**: Permission denied
- **Solution**: Make executable: `chmod +x scripts/test-all-datasets-timestamps.sh`

**Issue**: Results file not found
- **Solution**: Check `/tmp/` directory, or script will print the path

### Future Enhancements

Potential improvements:
- [ ] Parallel execution with rate limiting
- [ ] Real-time streaming output
- [ ] Historical comparison (track changes over time)
- [ ] Alert on regressions
- [ ] Performance metrics (response times)
- [ ] Chain health scoring

### Contributing

To test the script:
```bash
# Test with sample datasets
./scripts/test-all-datasets-timestamps.sh table | head -50

# Test JSON parsing
./scripts/test-all-datasets-timestamps.sh json | jq '.[0]'

# Verify CSV format
./scripts/test-all-datasets-timestamps.sh csv | head -5
```

### License

MIT License - Part of Portal MCP Server project

---

**Last Updated**: 2026-02-06
**Version**: 1.0.0
**Maintainer**: Portal MCP Team
