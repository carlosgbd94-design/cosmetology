import urllib.request
import json
try:
    with urllib.request.urlopen('https://api.github.com/repos/carlosgbd94-design/cosmetology/actions/runs') as url:
        data = json.loads(url.read().decode())
        for r in data.get('workflow_runs', [])[:3]:
            print(f"{r['name']}: {r['status']} - {r['conclusion']}")
            if r['conclusion'] == 'failure':
                print(f"Failed job URL: {r['html_url']}")
except Exception as e:
    print(e)
