import urllib.request
import json
import sys
try:
    with urllib.request.urlopen('https://api.github.com/repos/carlosgbd94-design/cosmetology/actions/runs/27522097548/jobs') as url:
        data = json.loads(url.read().decode())
        for job in data['jobs']:
            print(f"Job: {job['name']}, Status: {job['status']}, Conclusion: {job['conclusion']}")
            if job['conclusion'] == 'failure':
                for step in job['steps']:
                    if step['conclusion'] == 'failure':
                        print(f"Failed step: {step['name']}")
except Exception as e:
    print(e)
